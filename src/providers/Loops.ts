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
import { destinationId, makeDestination, providerMessageId } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  DeliveryUncertain,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { Attachment, PreparedMessage } from "../Message"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface LoopsOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly transactionalId?: string
  readonly addToAudience?: boolean
  readonly baseUrl?: string
  readonly account?: string
}

export interface LoopsSendResult {
  readonly id: ProviderMessageId
}

export interface LoopsClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: LoopsPayload,
    options?: {
      readonly idempotencyKey?: string
      readonly fallbackId: string
    }
  ) => Effect.Effect<LoopsSendResult, TransportError>
}

export class Client extends Context.Service<Client, LoopsClient>()(
  "@effect-email/providers/Loops/Client"
) {}

export interface LoopsAttachment {
  readonly filename: string
  readonly contentType: string
  readonly data: string
}

export interface LoopsPayload {
  readonly transactionalId: string
  readonly email: string
  readonly addToAudience?: boolean
  readonly dataVariables?: Readonly<Record<string, unknown>>
  readonly attachments?: ReadonlyArray<LoopsAttachment>
}

export const LoopsSuccess = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  id: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String)
    })
  )
})

type LoopsBody = typeof LoopsSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 1,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "request",
  idempotencyWindowMillis: 24 * 60 * 60 * 1000
})

const IDEMPOTENCY_KEY_LIMIT = 100

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<LoopsAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Loops requires attachment bytes; provide content instead of a path or URL",
        provider: "loops",
        capability: "attachments"
      })
    )
  }
  return Effect.succeed({
    filename: attachment.filename,
    contentType: attachment.contentType ?? "application/octet-stream",
    data:
      attachment.source.encoding === "base64"
        ? new TextDecoder().decode(attachment.source.content)
        : Base64.encode(attachment.source.content)
  })
}

const messageOf = (body: LoopsBody | undefined): string | undefined => {
  if (body === undefined) {
    return undefined
  }
  const nested =
    body.error?.message === undefined
      ? undefined
      : body.error.reason === undefined
        ? body.error.message
        : `${body.error.message} (${body.error.reason})`
  return [body.message, nested].filter((part) => part !== undefined).join(": ") ||
    undefined
}

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<LoopsBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(LoopsSuccess)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

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

const headerValue = (
  response: HttpClientResponse.HttpClientResponse,
  name: string
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, name))

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: LoopsBody
): TransportError => {
  const message =
    messageOf(body) ?? `Loops request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "loops",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
  if (response.status === 401 || response.status === 403) {
    return AuthenticationFailed.new(common)
  }
  if (response.status === 429) {
    return RateLimited.new({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return TransportUnavailable.new({ ...common, retryable: true })
  }
  return ProviderRejected.new(common)
}

const validate = (
  message: PreparedMessage,
  transactionalId: string | undefined
): Effect.Effect<
  { readonly transactionalId: string; readonly content: Extract<PreparedMessage["content"], { _tag: "provider-template" }> },
  UnsupportedCapability
> => {
  if (transactionalId === undefined) {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Loops sends a transactional email by id; set providerTemplate.id or the Loops transactionalId option",
        provider: "loops",
        capability: "provider-templates"
      })
    )
  }
  if (message.content._tag !== "provider-template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Loops renders the transactional email it stores; use providerTemplate content",
        provider: "loops",
        capability: "local-templates"
      })
    )
  }
  if (message.to.length !== 1) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `Loops sends to exactly one recipient per call, got ${message.to.length}`,
        provider: "loops",
        capability: "recipients"
      })
    )
  }
  if (
    message.cc.length > 0 ||
    message.bcc.length > 0 ||
    message.replyTo.length > 0
  ) {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Loops does not carry cc, bcc or reply-to; set them on the stored email",
        provider: "loops",
        capability: "recipients"
      })
    )
  }
  if (message.headers.length > 0) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "Loops does not carry custom headers",
        provider: "loops",
        capability: "headers"
      })
    )
  }
  return Effect.succeed({ transactionalId, content: message.content })
}

const payloadFor = (
  message: PreparedMessage,
  options: LoopsOptions,
  transactionalId: string,
  content: Extract<PreparedMessage["content"], { _tag: "provider-template" }>
): Effect.Effect<LoopsPayload, TransportError> =>
  Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const variables: Record<string, unknown> = {
        ...content.variables
      }
      for (const tag of message.tags) {
        variables[tag] = true
      }
      return {
        transactionalId,
        email: message.to[0]!.address,
        ...(options.addToAudience === undefined
          ? {}
          : { addToAudience: options.addToAudience }),
        ...(Object.keys(variables).length === 0
          ? {}
          : { dataVariables: variables }),
        ...(attachments.length === 0 ? {} : { attachments })
      }
    })
  )

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: LoopsOptions
) =>
  Effect.fn("Loops.sendEmail")(function* (
    payload: LoopsPayload,
    requestOptions: {
      readonly idempotencyKey?: string
      readonly fallbackId: string
    } = { fallbackId: `${payload.transactionalId}:${payload.email}` }
  ): Effect.fn.Return<LoopsSendResult, TransportError> {
    const endpoint = (options.baseUrl ?? "https://app.loops.so").replace(
      /\/$/,
      ""
    )
    const request = pipe(
      HttpClientRequest.post(`${endpoint}/api/v1/transactional`),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(options.apiKey)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      requestOptions.idempotencyKey === undefined
        ? (request) => request
        : HttpClientRequest.setHeader(
            "Idempotency-Key",
            requestOptions.idempotencyKey
          ),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "Loops request failed before a response was received; outcome is unknown",
            provider: "loops",
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readErrorBody(response))
    }
    const raw = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Loops returned an unreadable success response",
            provider: "loops",
            status: response.status,
            cause
          })
      )
    )
    const body = yield* Schema.decodeUnknownEffect(LoopsSuccess)(raw).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Loops returned an unreadable success response",
            provider: "loops",
            status: response.status,
            cause
          })
      )
    )
    if (body.success === false) {
      return yield* ProviderRejected.new({
        message: messageOf(body) ?? "Loops rejected the send",
        provider: "loops",
        status: response.status,
        retryable: false,
        cause: raw
      })
    }
    return {
      id: providerMessageId(
        body.id ?? requestOptions.idempotencyKey ?? requestOptions.fallbackId
      )
    }
  })

const makeTransport = (
  options: LoopsOptions,
  sendEmail: LoopsClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "loops",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Loops.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const message = envelope.message
    const transactionalId =
      message.content._tag === "provider-template"
        ? message.content.id
        : options.transactionalId
    const { transactionalId: id, content } = yield* validate(
      message,
      transactionalId
    )
    if (
      envelope.providerIdempotencyKey !== undefined &&
      envelope.providerIdempotencyKey.length > IDEMPOTENCY_KEY_LIMIT
    ) {
      return yield* UnsupportedCapability.new({
        message: `Loops accepts at most ${IDEMPOTENCY_KEY_LIMIT} characters for an idempotency key`,
        provider: "loops",
        capability: "idempotency"
      })
    }
    const payload = yield* payloadFor(message, options, id, content)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload, {
      ...(envelope.providerIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: envelope.providerIdempotencyKey }),
      fallbackId: `${id}:${payload.email}`
    })
    return {
      deliveryId: envelope.deliveryId,
      provider: "loops",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: LoopsOptions
): Effect.Effect<LoopsClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: LoopsOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: LoopsOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: LoopsOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: LoopsOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<LoopsOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("LOOPS_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "loops", account })
