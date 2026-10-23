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

export interface Smtp2goOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly region?: "us" | "eu" | "au"
  readonly baseUrl?: string
  readonly account?: string
}

export interface Smtp2goSendResult {
  readonly id: ProviderMessageId
  readonly requestId?: string
}

export interface Smtp2goClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: Smtp2goPayload
  ) => Effect.Effect<Smtp2goSendResult, TransportError>
}

export class Client extends Context.Service<Client, Smtp2goClient>()(
  "@effect-email/providers/Smtp2go/Client"
) {}

export interface Smtp2goFile {
  readonly filename: string
  readonly mimetype?: string
  readonly url?: string
  readonly fileblob?: string
}

export interface Smtp2goPayload {
  readonly sender: string
  readonly to: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly subject?: string
  readonly text_body?: string
  readonly html_body?: string
  readonly template_id?: string
  readonly template_data?: Readonly<Record<string, unknown>>
  readonly custom_headers?: ReadonlyArray<{
    readonly header: string
    readonly value: string
  }>
  readonly attachments?: ReadonlyArray<Smtp2goFile>
  readonly inlines?: ReadonlyArray<Smtp2goFile>
}

export const Smtp2goResponse = Schema.Struct({
  request_id: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(
    Schema.Struct({
      succeeded: Schema.optionalKey(Schema.Number),
      failed: Schema.optionalKey(Schema.Number),
      failures: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      email_id: Schema.optionalKey(Schema.NonEmptyString),
      schedule_id: Schema.optionalKey(Schema.NonEmptyString),
      error: Schema.optionalKey(Schema.String),
      error_code: Schema.optionalKey(Schema.String)
    })
  )
})
type Smtp2goBody = typeof Smtp2goResponse.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 100,
  attachments: true,
  remoteAttachments: true,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const RECIPIENT_LIMIT = 100
const HOSTS = {
  us: "https://us-api.smtp2go.com",
  eu: "https://eu-api.smtp2go.com",
  au: "https://au-api.smtp2go.com"
} as const
const GLOBAL_HOST = "https://api.smtp2go.com"
const AUTH_ERROR_CODE = /PERMISSION|AUTH|API_KEY|UNAUTHORIZED|FORBIDDEN/i

const formatAddress = (address: NormalizedAddress): string =>
  address.name === undefined
    ? address.address
    : `"${address.name.replace(/"/g, '\\"')}" <${address.address}>`

const fileFor = (
  attachment: Attachment,
  filename: string
): Effect.Effect<Smtp2goFile, UnsupportedCapability> => {
  const common = {
    filename,
    ...(attachment.contentType === undefined
      ? {}
      : { mimetype: attachment.contentType })
  }
  if (attachment.source._tag === "url") {
    return Effect.succeed({ ...common, url: attachment.source.url })
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "SMTP2GO adapter cannot read attachments from local paths; provide bytes or a URL instead",
        provider: "smtp2go",
        capability: "attachments"
      })
    )
  }
  const content =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({ ...common, fileblob: content })
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<Smtp2goPayload, TransportError> => {
  if (message.to.length > RECIPIENT_LIMIT) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `SMTP2GO accepts at most ${RECIPIENT_LIMIT} to recipients, got ${message.to.length}`,
        provider: "smtp2go",
        capability: "recipients"
      })
    )
  }

  const content = message.content
  if (content._tag !== "rendered" && content._tag !== "provider-template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `SMTP2GO adapter does not support ${content._tag} content`,
        provider: "smtp2go",
        capability: content._tag === "raw" ? "raw-mime" : "local-templates"
      })
    )
  }

  return Effect.gen(function* () {
    const headers: Array<readonly [string, string]> = [...message.headers]
    if (message.replyTo.length > 0) {
      headers.push(["Reply-To", message.replyTo.map(formatAddress).join(", ")])
    }
    for (const tag of message.tags) {
      headers.push([`X-Tag-${tag}`, "true"])
    }

    const files: Array<Attachment> = []
    const inlines: Array<Attachment> = []
    for (const attachment of message.attachments) {
      if (attachment.contentId === undefined) {
        files.push(attachment)
      } else {
        inlines.push(attachment)
      }
    }

    const attachments = yield* Effect.forEach(files, (attachment) =>
      fileFor(attachment, attachment.filename)
    )
    const inlineFiles = yield* Effect.forEach(inlines, (attachment) =>
      fileFor(attachment, attachment.contentId ?? attachment.filename)
    )

    return {
      sender: formatAddress(message.from),
      to: message.to.map(formatAddress),
      ...(message.cc.length === 0
        ? {}
        : { cc: message.cc.map(formatAddress) }),
      ...(message.bcc.length === 0
        ? {}
        : { bcc: message.bcc.map(formatAddress) }),
      subject: message.subject,
      ...(content._tag === "rendered"
        ? {
            ...(content.text === undefined ? {} : { text_body: content.text }),
            ...(content.html === undefined ? {} : { html_body: content.html })
          }
        : {
            template_id: content.id,
            ...(content.variables === undefined
              ? {}
              : { template_data: content.variables })
          }),
      ...(headers.length === 0
        ? {}
        : {
            custom_headers: headers.map(([header, value]) => ({
              header,
              value
            }))
          }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(inlineFiles.length === 0 ? {} : { inlines: inlineFiles })
    }
  })
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

const readBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Smtp2goBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(Smtp2goResponse)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: Smtp2goBody
): TransportError => {
  const message =
    body.data?.error ?? `SMTP2GO request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "smtp2go",
    status: response.status,
    ...(body.request_id === undefined ? {} : { requestId: body.request_id }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    (body.data?.error_code !== undefined &&
      AUTH_ERROR_CODE.test(body.data.error_code))
  ) {
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

const describeFailure = (failure: unknown): string => {
  if (typeof failure === "string") {
    return failure
  }
  if (failure !== null && typeof failure === "object") {
    const record = failure as Record<string, unknown>
    const parts = [record.recipient ?? record.email, record.error ?? record.message ?? record.reason]
      .filter((part): part is string => typeof part === "string")
    return parts.length > 0 ? parts.join(": ") : JSON.stringify(failure)
  }
  return String(failure)
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) =>
  Effect.fn("Smtp2go.sendEmail")(function* (
    payload: Smtp2goPayload
  ): Effect.fn.Return<Smtp2goSendResult, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/v3/email/send`),
      HttpClientRequest.setHeader(
        "x-smtp2go-api-key",
        Redacted.value(apiKey)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "SMTP2GO request failed before a response was received; outcome is unknown",
            provider: "smtp2go",
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readBody(response)
      return yield* classifyFailure(response, body)
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "SMTP2GO returned an unreadable success response",
            provider: "smtp2go",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(Smtp2goResponse)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "SMTP2GO returned an unreadable success response",
            provider: "smtp2go",
            status: response.status,
            cause
          })
      )
    )
    const data = decoded.data ?? {}
    const failures = data.failures ?? []
    if ((data.failed ?? 0) > 0 || failures.length > 0) {
      const reason = failures
        .map(describeFailure)
        .filter((part) => part.length > 0)
        .join("; ")
      const common = {
        message:
          reason.length > 0
            ? reason
            : `${data.failed ?? failures.length} failed`,
        provider: "smtp2go",
        status: response.status,
        ...(decoded.request_id === undefined
          ? {}
          : { requestId: decoded.request_id })
      }
      if ((data.succeeded ?? 0) > 0) {
        return yield* DeliveryUncertain.new(common)
      }
      return yield* ProviderRejected.new({
        ...common,
        retryable: false
      })
    }

    const id = data.schedule_id ?? data.email_id
    if (id === undefined) {
      return yield* MalformedProviderResponse.new({
        message: "SMTP2GO success response did not contain email_id",
        provider: "smtp2go",
        status: response.status,
        cause: body
      })
    }
    return {
      id: providerMessageId(id),
      ...(decoded.request_id === undefined
        ? {}
        : { requestId: decoded.request_id })
    }
  })

const makeTransport = (
  options: Smtp2goOptions,
  sendEmail: Smtp2goClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "smtp2go",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Smtp2go.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload)
    return {
      deliveryId: envelope.deliveryId,
      provider: "smtp2go",
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
  options: Smtp2goOptions
): Effect.Effect<Smtp2goClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? (options.region === undefined ? GLOBAL_HOST : HOSTS[options.region])
    const sendEmail = makeSendEmail(
      httpClient,
      options.apiKey,
      baseUrl.replace(/\/$/, "")
    )
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: Smtp2goOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: Smtp2goOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: Smtp2goOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: Smtp2goOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<Smtp2goOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("SMTP2GO_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "smtp2go", account })

