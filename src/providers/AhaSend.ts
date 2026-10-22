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
  DeliveryUncertain,
  IdempotencyConflict,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
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

export interface AhaSendOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly accountId: string
  readonly baseUrl?: string
  readonly sandbox?: boolean
  readonly sandboxResult?: "deliver" | "bounce" | "defer" | "fail" | "suppress"
  readonly account?: string
}

export interface AhaSendSendResult {
  readonly id: ProviderMessageId
}

export interface AhaSendClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: AhaSendPayload,
    options?: {
      readonly idempotencyKey?: string
      readonly conversational?: boolean
    }
  ) => Effect.Effect<AhaSendSendResult, TransportError>
}

export class Client extends Context.Service<Client, AhaSendClient>()(
  "@effect-email/providers/AhaSend/Client"
) {}

export interface AhaSendAddress {
  readonly email: string
  readonly name?: string
}

export interface AhaSendAttachment {
  readonly file_name: string
  readonly content_type: string
  readonly base64: true
  readonly data: string
  readonly content_id?: string
  readonly content_disposition?: "attachment" | "inline"
}

export interface AhaSendPayload {
  readonly from: AhaSendAddress
  readonly subject: string
  readonly to?: ReadonlyArray<AhaSendAddress>
  readonly cc?: ReadonlyArray<AhaSendAddress>
  readonly bcc?: ReadonlyArray<AhaSendAddress>
  readonly recipients?: ReadonlyArray<AhaSendAddress>
  readonly reply_to?: AhaSendAddress
  readonly text_content?: string
  readonly html_content?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly tags?: ReadonlyArray<string>
  readonly sandbox?: true
  readonly sandbox_result?: string
  readonly attachments?: ReadonlyArray<AhaSendAttachment>
}

export const AhaSendEntry = Schema.Struct({
  object: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  recipient: Schema.optionalKey(
    Schema.Struct({
      email: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String)
    })
  ),
  status: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const AhaSendSuccess = Schema.Struct({
  object: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Array(AhaSendEntry))
})

export const AhaSendErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

type AhaSendBody = typeof AhaSendSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "request",
  idempotencyWindowMillis: 24 * 60 * 60 * 1000
})

const CONVERSATION_RECIPIENT_LIMIT = 50

const formatAddress = (address: NormalizedAddress): AhaSendAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<AhaSendAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      new UnsupportedCapability({
        message: "AhaSend does not accept remote attachment URLs",
        provider: "ahasend",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "AhaSend adapter cannot read attachments from local paths; provide bytes instead",
        provider: "ahasend",
        capability: "attachments"
      })
    )
  }
  const data =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({
    file_name: attachment.filename,
    content_type: attachment.contentType ?? "application/octet-stream",
    base64: true,
    data,
    ...(attachment.contentId === undefined
      ? {}
      : {
          content_id: `<${attachment.contentId.replace(/^<|>$/g, "")}>`
        }),
    ...(attachment.disposition === undefined
      ? {}
      : { content_disposition: attachment.disposition })
  })
}

const payloadFor = (
  message: PreparedMessage,
  options: AhaSendOptions,
  conversational: boolean
): Effect.Effect<AhaSendPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `AhaSend adapter supports rendered content only, received ${message.content._tag}`,
        provider: "ahasend",
        capability: "content"
      })
    )
  }
  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const headers: Record<string, string> = Object.fromEntries(
        message.headers
      )
      if (message.replyTo.length > 1) {
        headers["reply-to"] = message.replyTo
          .map((address) =>
            address.name === undefined
              ? address.address
              : `${address.name} <${address.address}>`
          )
          .join(", ")
      }
      return {
        from: formatAddress(message.from),
        subject: message.subject,
        ...(conversational
          ? {
              to: message.to.map(formatAddress),
              ...(message.cc.length === 0
                ? {}
                : { cc: message.cc.map(formatAddress) }),
              ...(message.bcc.length === 0
                ? {}
                : { bcc: message.bcc.map(formatAddress) })
            }
          : { recipients: message.to.map(formatAddress) }),
        ...(message.replyTo.length === 1
          ? { reply_to: formatAddress(message.replyTo[0]!) }
          : {}),
        ...(content.text === undefined ? {} : { text_content: content.text }),
        ...(content.html === undefined ? {} : { html_content: content.html }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(message.tags.length === 0 ? {} : { tags: [...message.tags] }),
        ...(options.sandbox === true
          ? {
              sandbox: true as const,
              ...(options.sandboxResult === undefined
                ? {}
                : { sandbox_result: options.sandboxResult })
            }
          : {}),
        ...(attachments.length === 0 ? {} : { attachments })
      }
    })
  )
}

const headerValue = (
  response: HttpClientResponse.HttpClientResponse,
  name: string
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, name))

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
): Effect.Effect<typeof AhaSendErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(AhaSendErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof AhaSendErrorBody.Type,
  idempotencyKey: string | undefined
): TransportError => {
  const message =
    body.message ??
    body.error ??
    `AhaSend request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "ahasend",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (response.status === 422) {
    return new IdempotencyConflict({
      ...common,
      ...(idempotencyKey === undefined
        ? {}
        : { idempotencyKey })
    })
  }
  if (response.status === 409) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationFailed(common)
  }
  if (response.status === 429) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: AhaSendOptions
) =>
  Effect.fn("AhaSend.sendEmail")(function* (
    payload: AhaSendPayload,
    requestOptions: {
      readonly idempotencyKey?: string
      readonly conversational?: boolean
    } = {}
  ): Effect.fn.Return<AhaSendSendResult, TransportError> {
    const endpoint = (options.baseUrl ?? "https://api.ahasend.com").replace(/\/$/, "")
    const account = `${endpoint}/v2/accounts/${encodeURIComponent(options.accountId)}`
    const path =
      requestOptions.conversational === true
        ? "/messages/conversation"
        : "/messages"
    const request = pipe(
      HttpClientRequest.post(`${account}${path}`),
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
          new TransportUnavailable({
            message: "AhaSend request failed before a response was received",
            provider: "ahasend",
            retryable: true,
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(
        response,
        yield* readErrorBody(response),
        requestOptions.idempotencyKey
      )
    }

    const raw = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "AhaSend returned an unreadable success response",
            provider: "ahasend",
            status: response.status,
            cause
          })
      )
    )
    const body = yield* Schema.decodeUnknownEffect(AhaSendSuccess)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "AhaSend returned an unreadable success response",
            provider: "ahasend",
            status: response.status,
            cause
          })
      )
    )
    const entries = body.data ?? []
    const acceptedIds: Array<string> = []
    const rejections: Array<string> = []
    for (const entry of entries) {
      if (entry.id != null && entry.status !== "error") {
        acceptedIds.push(entry.id)
      }
      if (entry.error != null) {
        rejections.push(entry.error)
      }
    }
    if (acceptedIds.length === 0) {
      if (rejections.length > 0) {
        return yield* new ProviderRejected({
          message: rejections.join("; "),
          provider: "ahasend",
          status: response.status,
          retryable: false
        })
      }
      return yield* new MalformedProviderResponse({
        message: "AhaSend response did not contain a message id",
        provider: "ahasend",
        status: response.status,
        cause: raw
      })
    }
    if (rejections.length > 0) {
      return yield* new DeliveryUncertain({
        message: `AhaSend accepted some recipients but rejected others: ${rejections.join("; ")}`,
        provider: "ahasend",
        status: response.status,
        cause: raw
      })
    }
    return { id: providerMessageId(acceptedIds[0]!) }
  })

const makeTransport = (
  options: AhaSendOptions,
  sendEmail: AhaSendClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "ahasend",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("AhaSend.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const message = envelope.message
    const conversational =
      message.cc.length > 0 ||
      message.bcc.length > 0 ||
      message.to.length > 1
    const recipients =
      message.to.length + message.cc.length + message.bcc.length
    if (conversational && recipients > CONVERSATION_RECIPIENT_LIMIT) {
      return yield* new UnsupportedCapability({
        message: `AhaSend accepts at most ${CONVERSATION_RECIPIENT_LIMIT} combined recipients for a conversation`,
        provider: "ahasend",
        capability: "recipients"
      })
    }

    const payload = yield* payloadFor(message, options, conversational)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload, {
      ...(envelope.providerIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: envelope.providerIdempotencyKey }),
      conversational
    })
    return {
      deliveryId: envelope.deliveryId,
      provider: "ahasend",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: AhaSendOptions
): Effect.Effect<AhaSendClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: AhaSendOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: AhaSendOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: AhaSendOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: AhaSendOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<AhaSendOptions, "apiKey" | "accountId"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        apiKey: Config.Redacted("AHASEND_API_KEY"),
        accountId: Config.String("AHASEND_ACCOUNT_ID")
      }),
      ({ apiKey, accountId }) =>
        layerTransport({ ...options, apiKey, accountId })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "ahasend", account })
