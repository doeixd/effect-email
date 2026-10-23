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

export interface CloudflareEmailRestOptions {
  readonly accountId: string
  readonly apiToken: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
}

export interface CloudflareEmailRestResult {
  readonly delivered?: ReadonlyArray<string>
  readonly permanent_bounces?: ReadonlyArray<string>
  readonly queued?: ReadonlyArray<string>
  readonly message_id?: string
  readonly suppressed_recipients?: ReadonlyArray<string>
}

export interface CloudflareEmailRestSendResult {
  readonly id: ProviderMessageId
  readonly result: CloudflareEmailRestResult
}

export interface CloudflareEmailRestClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: CloudflareEmailRestPayload,
    options?: { readonly messageIdHeader?: string }
  ) => Effect.Effect<CloudflareEmailRestSendResult, TransportError>
}

export class Client extends Context.Service<Client, CloudflareEmailRestClient>()(
  "@effect-email/providers/CloudflareEmailRest/Client"
) {}

export interface CloudflareEmailRestAddress {
  readonly address: string
  readonly name?: string
}

export interface CloudflareEmailRestAttachment {
  readonly content: string
  readonly filename: string
  readonly type: string
  readonly disposition: "attachment" | "inline"
  readonly content_id?: string
}

export interface CloudflareEmailRestPayload {
  readonly from: CloudflareEmailRestAddress
  readonly to: ReadonlyArray<CloudflareEmailRestAddress>
  readonly cc?: ReadonlyArray<CloudflareEmailRestAddress>
  readonly bcc?: ReadonlyArray<CloudflareEmailRestAddress>
  readonly reply_to?: CloudflareEmailRestAddress
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: ReadonlyArray<CloudflareEmailRestAttachment>
}

export const CloudflareEmailRestSuccess = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.Int),
        message: Schema.optionalKey(Schema.String)
      })
    )
  ),
  messages: Schema.optionalKey(Schema.Array(Schema.String)),
  result: Schema.optionalKey(
    Schema.Struct({
      delivered: Schema.optionalKey(Schema.Array(Schema.String)),
      permanent_bounces: Schema.optionalKey(Schema.Array(Schema.String)),
      queued: Schema.optionalKey(Schema.Array(Schema.String)),
      message_id: Schema.optionalKey(Schema.String),
      suppressed_recipients: Schema.optionalKey(
        Schema.Array(Schema.String)
      )
    })
  )
})

type CloudflareBody = typeof CloudflareEmailRestSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const RECIPIENT_LIMIT = 50
const ATTACHMENT_LIMIT = 32

const formatAddress = (
  address: NormalizedAddress
): CloudflareEmailRestAddress =>
  address.name === undefined
    ? { address: address.address }
    : { address: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<CloudflareEmailRestAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Cloudflare Email Service requires attachment bytes; provide content instead of a path or URL",
        provider: "cloudflare-email-rest",
        capability: "attachments"
      })
    )
  }
  return Effect.succeed({
    content:
      attachment.source.encoding === "base64"
        ? new TextDecoder().decode(attachment.source.content)
        : Base64.encode(attachment.source.content),
    filename: attachment.filename,
    type: attachment.contentType ?? "application/octet-stream",
    disposition:
      attachment.disposition ?? (attachment.contentId ? "inline" : "attachment"),
    ...(attachment.contentId === undefined
      ? {}
      : { content_id: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<CloudflareEmailRestPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Cloudflare Email Service adapter supports rendered content only, received ${message.content._tag}`,
        provider: "cloudflare-email-rest",
        capability: "content"
      })
    )
  }
  const recipients = message.to.length + message.cc.length + message.bcc.length
  if (recipients > RECIPIENT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Cloudflare Email Service accepts at most ${RECIPIENT_LIMIT} recipients across to/cc/bcc, got ${recipients}`,
        provider: "cloudflare-email-rest",
        capability: "recipients"
      })
    )
  }
  if (message.attachments.length > ATTACHMENT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Cloudflare Email Service accepts at most ${ATTACHMENT_LIMIT} attachments, got ${message.attachments.length}`,
        provider: "cloudflare-email-rest",
        capability: "attachments"
      })
    )
  }
  if (message.replyTo.length > 1) {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Cloudflare Email Service accepts a single reply-to address",
        provider: "cloudflare-email-rest",
        capability: "reply-to"
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
        : { reply_to: formatAddress(message.replyTo[0]!) }),
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

const ERROR_CODES: Readonly<
  Record<
    number,
    "invalid" | "auth" | "rate" | "network"
  >
> = {
  10001: "invalid",
  10200: "invalid",
  10101: "auth",
  10102: "auth",
  10004: "rate",
  10002: "network"
}

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

const readBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<CloudflareBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(CloudflareEmailRestSuccess)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: CloudflareBody
): TransportError => {
  const first = body.errors?.[0]
  const message =
    first?.message ??
    `Cloudflare Email Service request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "cloudflare-email-rest",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
  const kind =
    first?.code === undefined ? undefined : ERROR_CODES[first.code]
  if (kind === "auth" || response.status === 401 || response.status === 403) {
    return new AuthenticationFailed(common)
  }
  if (kind === "rate" || response.status === 429) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (kind === "network" || response.status >= 500) {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: CloudflareEmailRestOptions
) =>
  Effect.fn("CloudflareEmailRest.sendEmail")(function* (
    payload: CloudflareEmailRestPayload,
    requestOptions: { readonly messageIdHeader?: string } = {}
  ): Effect.fn.Return<CloudflareEmailRestSendResult, TransportError> {
    const endpoint = (
      options.baseUrl ?? "https://api.cloudflare.com/client/v4"
    ).replace(/\/$/, "")
    const request = pipe(
      HttpClientRequest.post(
        `${endpoint}/accounts/${encodeURIComponent(options.accountId)}/email/sending/send`
      ),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(options.apiToken)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message:
              "Cloudflare Email Service request failed before a response was received; outcome is unknown",
            provider: "cloudflare-email-rest",
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readBody(response))
    }
    const raw = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Cloudflare Email Service returned unreadable JSON",
            provider: "cloudflare-email-rest",
            status: response.status,
            cause
          })
      )
    )
    const body = yield* Schema.decodeUnknownEffect(
      CloudflareEmailRestSuccess
    )(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Cloudflare Email Service returned an unreadable response",
            provider: "cloudflare-email-rest",
            status: response.status,
            cause
          })
      )
    )
    const failure = body.errors?.[0]?.message
    if (body.success === false) {
      return yield* new ProviderRejected({
        message: failure ?? "Cloudflare Email Service rejected the send",
        provider: "cloudflare-email-rest",
        status: response.status,
        retryable: false,
        cause: raw
      })
    }
    const result = body.result ?? {}
    const bounced = result.permanent_bounces ?? []
    const suppressed = result.suppressed_recipients ?? []
    const accepted = [...(result.delivered ?? []), ...(result.queued ?? [])]
    if (bounced.length > 0 && accepted.length === 0) {
      return yield* new ProviderRejected({
        message: `permanently bounced for every recipient: ${bounced.join(", ")}`,
        provider: "cloudflare-email-rest",
        status: response.status,
        retryable: false,
        cause: raw
      })
    }
    if (suppressed.length > 0 && accepted.length === 0) {
      return yield* new ProviderRejected({
        message: `suppressed every recipient: ${suppressed.join(", ")}`,
        provider: "cloudflare-email-rest",
        status: response.status,
        retryable: false,
        cause: raw
      })
    }
    if (bounced.length > 0 || suppressed.length > 0) {
      return yield* new DeliveryUncertain({
        message: `some recipients were not accepted: ${[
          ...bounced,
          ...suppressed
        ].join(", ")}`,
        provider: "cloudflare-email-rest",
        status: response.status,
        cause: raw
      })
    }
    if (result.message_id === undefined) {
      return yield* new MalformedProviderResponse({
        message:
          "Cloudflare Email Service accepted the request without a message id",
        provider: "cloudflare-email-rest",
        status: response.status,
        cause: raw
      })
    }
    return {
      id: providerMessageId(result.message_id),
      result
    }
  })

const makeTransport = (
  options: CloudflareEmailRestOptions,
  sendEmail: CloudflareEmailRestClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "cloudflare-email-rest",
    account: options.account ?? options.accountId
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("CloudflareEmailRest.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const message = envelope.message
    const payload = yield* payloadFor(message)
    const acceptedAt = yield* DateTime.now
    const messageIdHeader = message.headers.find(
      ([name]) => name.toLowerCase() === "message-id"
    )?.[1]
    const result = yield* sendEmail(payload, {
      ...(messageIdHeader === undefined ? {} : { messageIdHeader })
    })
    return {
      deliveryId: envelope.deliveryId,
      provider: "cloudflare-email-rest",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: CloudflareEmailRestOptions
): Effect.Effect<CloudflareEmailRestClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: CloudflareEmailRestOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: CloudflareEmailRestOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: CloudflareEmailRestOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: CloudflareEmailRestOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<CloudflareEmailRestOptions, "accountId" | "apiToken"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        accountId: Config.String("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: Config.Redacted("CLOUDFLARE_API_TOKEN")
      }),
      ({ accountId, apiToken }) =>
        layerTransport({ ...options, accountId, apiToken })
    )
  )

export const destinationFor = (account: string): Destination =>
  makeDestination({ provider: "cloudflare-email-rest", account })
