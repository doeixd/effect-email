import {
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  pipe,
  Redacted,
  Schema
} from "effect"
import { Base64 } from "effect/encoding"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import type { Destination, ProviderMessageId } from "../Ids"
import {
  destinationId,
  makeDestination,
  providerMessageId
} from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  IdempotencyConflict,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  DeliveryUncertain,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { Attachment, NormalizedAddress, PreparedMessage } from "../Message"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface ResendOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
}

export interface ResendSendResult {
  readonly id: ProviderMessageId
  readonly requestId?: string
}

export interface ResendClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: ResendPayload,
    options?: { readonly idempotencyKey?: string }
  ) => Effect.Effect<ResendSendResult, TransportError>
}

export class Client extends Context.Service<Client, ResendClient>()(
  "@effect-email/providers/Resend/Client"
) {}

export const ResendSuccess = Schema.Struct({
  id: Schema.NonEmptyString
})

export const ResendErrorBody = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String)
})

export interface ResendAttachment {
  readonly filename: string
  readonly content?: string
  readonly path?: string
  readonly content_type?: string
  readonly content_id?: string
}

export interface ResendPayload {
  readonly from: string
  readonly to: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly reply_to?: ReadonlyArray<string>
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: ReadonlyArray<ResendAttachment>
}

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "request",
  idempotencyWindowMillis: 24 * 60 * 60 * 1000
})

const formatAddress = (address: NormalizedAddress): string =>
  address.name === undefined
    ? address.address
    : `"${address.name.replace(/"/g, '\\"')}" <${address.address}>`

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<ResendAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "Resend does not accept remote attachment URLs",
        provider: "resend",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Resend adapter cannot read attachments from local paths; provide bytes instead",
        provider: "resend",
        capability: "attachments"
      })
    )
  }
  const content =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({
    filename: attachment.filename,
    content,
    ...(attachment.contentType === undefined
      ? {}
      : { content_type: attachment.contentType }),
    ...(attachment.contentId === undefined
      ? {}
      : { content_id: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<ResendPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `Resend adapter supports rendered content only, received ${message.content._tag}`,
        provider: "resend",
        capability: "content"
      })
    )
  }

  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => ({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      ...(message.cc.length === 0
        ? {}
        : { cc: message.cc.map(formatAddress) }),
      ...(message.bcc.length === 0
        ? {}
        : { bcc: message.bcc.map(formatAddress) }),
      ...(message.replyTo.length === 0
        ? {}
        : { reply_to: message.replyTo.map(formatAddress) }),
      subject: message.subject,
      ...(content.text === undefined ? {} : { text: content.text }),
      ...(content.html === undefined ? {} : { html: content.html }),
      ...(message.headers.length === 0
        ? {}
        : { headers: Object.fromEntries(message.headers) }),
      ...(attachments.length === 0 ? {} : { attachments })
    }))
  )
}

const requestIdFor = (
  response: HttpClientResponse.HttpClientResponse
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, "x-request-id"))

const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) {
    return undefined
  }
  return Math.max(0, date - Date.now())
}

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<typeof ResendErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(ResendErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof ResendErrorBody.Type,
  idempotencyKey?: string
): TransportError => {
  const message = body.message ?? `Resend request failed with status ${response.status}`
  const requestId = requestIdFor(response)
  const retryAfterMillis = parseRetryAfter(
    Option.getOrUndefined(Headers.get(response.headers, "retry-after"))
  )
  const common = {
    message,
    provider: "resend",
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (response.status === 401 || response.status === 403) {
    return AuthenticationFailed.new(common)
  }
  if (response.status === 429) {
    return RateLimited.new({ ...common, retryable: true })
  }
  if (response.status === 409) {
    if (body.name === "concurrent_idempotent_requests") {
      return RateLimited.new({ ...common, retryable: true })
    }
    return IdempotencyConflict.new({
      ...common,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey })
    })
  }
  if (response.status >= 500) {
    return TransportUnavailable.new({ ...common, retryable: true })
  }
  return ProviderRejected.new(common)
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) =>
  Effect.fn("Resend.sendEmail")(function* (
    payload: ResendPayload,
    options: { readonly idempotencyKey?: string } = {}
  ): Effect.fn.Return<ResendSendResult, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/emails`),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(apiKey)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      options.idempotencyKey === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("Idempotency-Key", options.idempotencyKey),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "Resend request failed before a response was received; outcome is unknown",
            provider: "resend",
            cause
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(
        response,
        body,
        options.idempotencyKey
      )
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Resend returned an unreadable success response",
            provider: "resend",
            status: response.status,
            cause
          })
      )
    )

    const decoded = yield* Schema.decodeUnknownEffect(ResendSuccess)(body).pipe(
      Effect.mapError(
        (issue) =>
          MalformedProviderResponse.new({
            message: "Resend success response did not contain a message id",
            provider: "resend",
            status: response.status,
            cause: issue
          })
      )
    )

    const requestId = requestIdFor(response)
    return {
      id: providerMessageId(decoded.id),
      ...(requestId === undefined ? {} : { requestId })
    }
  })

const makeTransport = (
  options: ResendOptions,
  sendEmail: ResendClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "resend",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Resend.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload, {
      ...(envelope.providerIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: envelope.providerIdempotencyKey })
    })

    return {
      deliveryId: envelope.deliveryId,
      provider: "resend",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route,
      ...(result.requestId === undefined
        ? {}
        : { requestId: result.requestId })
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: ResendOptions
): Effect.Effect<ResendClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(
      httpClient,
      options.apiKey,
      options.baseUrl ?? "https://api.resend.com"
    )
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: ResendOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: ResendOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: ResendOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: ResendOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<ResendOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("RESEND_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "resend", account })


