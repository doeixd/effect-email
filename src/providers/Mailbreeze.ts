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
import type { NormalizedAddress, PreparedMessage } from "../Message"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface MailbreezeOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
}

export interface MailbreezeSendResult {
  readonly id: ProviderMessageId
  readonly sandbox: boolean
}

export interface MailbreezeClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: MailbreezePayload
  ) => Effect.Effect<MailbreezeSendResult, TransportError>
}

export class Client extends Context.Service<Client, MailbreezeClient>()(
  "@effect-email/providers/Mailbreeze/Client"
) {}

export interface MailbreezeAddress {
  readonly email: string
  readonly name?: string
}

export interface MailbreezePayload {
  readonly from: string
  readonly to: ReadonlyArray<string>
  readonly subject?: string
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly text?: string
  readonly html?: string
  readonly replyTo?: string
  readonly idempotencyKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly templateId?: string
  readonly variables?: Readonly<Record<string, unknown>>
}

export const MailbreezeSuccess = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  data: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  sandbox: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      details: Schema.optionalKey(Schema.Unknown)
    })
  )
})

type MailbreezeBody = typeof MailbreezeSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  attachments: false,
  remoteAttachments: false,
  rawMime: false,
  tags: false,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "request",
  idempotencyWindowMillis: 24 * 60 * 60 * 1000
})

const IDEMPOTENCY_KEY_LIMIT = 256

const formatAddress = (address: NormalizedAddress): string =>
  address.name === undefined
    ? address.address
    : /[",<>@;:\\]/.test(address.name)
      ? `"${address.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}" <${address.address}>`
      : `${address.name} <${address.address}>`

const formatAddressList = (addresses: ReadonlyArray<NormalizedAddress>): string =>
  addresses.map(formatAddress).join(", ")

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<MailbreezePayload, UnsupportedCapability> => {
  const content = message.content
  if (content._tag !== "rendered" && content._tag !== "provider-template") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailbreeze adapter does not support ${content._tag} content`,
        provider: "mailbreeze",
        capability: content._tag === "raw" ? "raw-mime" : "local-templates"
      })
    )
  }
  return Effect.succeed({
    from: formatAddress(message.from),
    to: message.to.map(formatAddress),
    subject: message.subject,
    ...(message.cc.length === 0
      ? {}
      : { cc: message.cc.map(formatAddress) }),
    ...(message.bcc.length === 0
      ? {}
      : { bcc: message.bcc.map(formatAddress) }),
    ...(content._tag === "rendered"
      ? {
          ...(content.text === undefined ? {} : { text: content.text }),
          ...(content.html === undefined ? {} : { html: content.html })
        }
      : {
          templateId: content.id,
          ...(content.variables === undefined
            ? {}
            : { variables: content.variables })
        }),
    ...(message.replyTo.length === 0
      ? {}
      : { replyTo: formatAddressList(message.replyTo) }),
    ...(message.headers.length === 0
      ? {}
      : { headers: Object.fromEntries(message.headers) })
  })
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
): Effect.Effect<MailbreezeBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(MailbreezeSuccess)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: MailbreezeBody
): TransportError => {
  const message =
    body.error?.message ??
    body.error?.code ??
    `Mailbreeze request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "mailbreeze",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
  if (body.error?.code === "SENDING_DISABLED") {
    return new ProviderRejected(common)
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: MailbreezeOptions
) =>
  Effect.fn("Mailbreeze.sendEmail")(function* (
    payload: MailbreezePayload
  ): Effect.fn.Return<MailbreezeSendResult, TransportError> {
    const endpoint = (options.baseUrl ?? "https://api.mailbreeze.com").replace(
      /\/$/,
      ""
    )
    const request = pipe(
      HttpClientRequest.post(`${endpoint}/v1/emails`),
      HttpClientRequest.setHeader(
        "X-Api-Key",
        Redacted.value(options.apiKey)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "Mailbreeze request failed before a response was received; outcome is unknown",
            provider: "mailbreeze",
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
            message: "Mailbreeze returned unreadable JSON",
            provider: "mailbreeze",
            status: response.status,
            cause
          })
      )
    )
    const body = yield* Schema.decodeUnknownEffect(MailbreezeSuccess)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Mailbreeze returned an unreadable response",
            provider: "mailbreeze",
            status: response.status,
            cause
          })
      )
    )
    if (body.success === false) {
      return yield* new ProviderRejected({
        message:
          body.error?.message ??
          "Mailbreeze rejected the send",
        provider: "mailbreeze",
        status: response.status,
        retryable: false,
        cause: raw
      })
    }
    const data = isRecord(body.data) ? body.data : body
    const id =
      typeof data.id === "string"
        ? data.id
        : typeof data.messageId === "string"
          ? data.messageId
          : undefined
    if (id === undefined) {
      return yield* new MalformedProviderResponse({
        message: "Mailbreeze response did not contain an email id",
        provider: "mailbreeze",
        status: response.status,
        cause: raw
      })
    }
    return {
      id: providerMessageId(id),
      sandbox: data.sandbox === true
    }
  })

const makeTransport = (
  options: MailbreezeOptions,
  sendEmail: MailbreezeClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "mailbreeze",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Mailbreeze.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const message = envelope.message
    if (envelope.providerIdempotencyKey !== undefined) {
      if (envelope.providerIdempotencyKey.length > IDEMPOTENCY_KEY_LIMIT) {
        return yield* new UnsupportedCapability({
          message: `Mailbreeze accepts at most ${IDEMPOTENCY_KEY_LIMIT} characters for an idempotency key`,
          provider: "mailbreeze",
          capability: "idempotency"
        })
      }
    }
    const payload = yield* payloadFor(message)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail({
      ...payload,
      ...(envelope.providerIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: envelope.providerIdempotencyKey })
    })
    return {
      deliveryId: envelope.deliveryId,
      provider: "mailbreeze",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: MailbreezeOptions
): Effect.Effect<MailbreezeClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: MailbreezeOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailbreezeOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailbreezeOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailbreezeOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailbreezeOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("MAILBREEZE_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailbreeze", account })
