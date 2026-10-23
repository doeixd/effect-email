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
  certaintyOf,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  DeliveryUncertain,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { Attachment, NormalizedAddress, PreparedMessage } from "../Message"
import type {
  MessageOutcome,
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type {
  NativeBatchTransport,
  Transport,
  TransportCapabilities
} from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface MailtrapOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly sandboxBaseUrl?: string
  readonly bulkBaseUrl?: string
  readonly defaultCategory?: string
  readonly userAgent?: string
  readonly sandbox?: boolean
  readonly inboxId?: number | string
  readonly bulk?: boolean
  readonly account?: string
}

export interface MailtrapSendResult {
  readonly id: ProviderMessageId
}

export interface MailtrapBatchResult {
  readonly ids: ReadonlyArray<ProviderMessageId | undefined>
}

export interface MailtrapClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: MailtrapPayload,
    sandbox: boolean
  ) => Effect.Effect<MailtrapSendResult, TransportError>
  readonly sendBatch: (
    payloads: ReadonlyArray<MailtrapPayload>,
    sandbox: boolean
  ) => Effect.Effect<MailtrapBatchResult, TransportError>
}

export class Client extends Context.Service<Client, MailtrapClient>()(
  "@effect-email/providers/Mailtrap/Client"
) {}

export interface MailtrapAddress {
  readonly email: string
  readonly name?: string
}

export interface MailtrapAttachment {
  readonly content: string
  readonly filename: string
  readonly type?: string
  readonly disposition?: "attachment" | "inline"
  readonly content_id?: string
}

export interface MailtrapPayload {
  readonly from: MailtrapAddress
  readonly to: ReadonlyArray<MailtrapAddress>
  readonly cc?: ReadonlyArray<MailtrapAddress>
  readonly bcc?: ReadonlyArray<MailtrapAddress>
  readonly reply_to?: MailtrapAddress
  readonly subject?: string
  readonly category?: string
  readonly text?: string
  readonly html?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly custom_variables?: Readonly<Record<string, string>>
  readonly template_uuid?: string
  readonly template_variables?: Readonly<Record<string, unknown>>
  readonly attachments?: ReadonlyArray<MailtrapAttachment>
}

export const MailtrapSendResponse = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  message_ids: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  errors: Schema.optionalKey(Schema.Unknown)
})

export const MailtrapBatchResponse = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  responses: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  errors: Schema.optionalKey(Schema.Unknown)
})

const BATCH_LIMIT = 500
const RECIPIENT_LIMIT = 1000
const CATEGORY_LIMIT = 255

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: BATCH_LIMIT,
  maxRecipientsPerMessage: RECIPIENT_LIMIT,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const formatAddress = (address: NormalizedAddress): MailtrapAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<MailtrapAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "Mailtrap does not accept remote attachment URLs",
        provider: "mailtrap",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Mailtrap adapter cannot read attachments from local paths; provide bytes instead",
        provider: "mailtrap",
        capability: "attachments"
      })
    )
  }
  const content =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({
    content,
    filename: attachment.filename,
    ...(attachment.contentType === undefined
      ? {}
      : { type: attachment.contentType }),
    ...(attachment.disposition === undefined
      ? {}
      : { disposition: attachment.disposition }),
    ...(attachment.contentId === undefined
      ? {}
      : { content_id: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage,
  defaultCategory: string
): Effect.Effect<MailtrapPayload, TransportError> => {
  if (message.to.length > RECIPIENT_LIMIT) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `Mailtrap accepts at most ${RECIPIENT_LIMIT} to recipients, got ${message.to.length}`,
        provider: "mailtrap",
        capability: "recipients"
      })
    )
  }
  const content = message.content
  if (content._tag !== "rendered" && content._tag !== "provider-template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `Mailtrap adapter does not support ${content._tag} content`,
        provider: "mailtrap",
        capability: content._tag === "raw" ? "raw-mime" : "local-templates"
      })
    )
  }

  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const categoryTag = message.tags.find((tag) => tag === "category")
      const custom: Record<string, string> = {}
      for (const tag of message.tags) {
        if (tag !== "category") {
          custom[`tag_${tag}`] = "true"
        }
      }
      return {
        from: formatAddress(message.from),
        to: message.to.map(formatAddress),
        ...(message.cc.length === 0
          ? {}
          : { cc: message.cc.map(formatAddress) }),
        ...(message.bcc.length === 0
          ? {}
          : { bcc: message.bcc.map(formatAddress) }),
        ...(message.replyTo[0] === undefined
          ? {}
          : { reply_to: formatAddress(message.replyTo[0]) }),
        ...(content._tag === "rendered"
          ? {
              subject: message.subject,
              category: (categoryTag ?? defaultCategory).slice(
                0,
                CATEGORY_LIMIT
              ),
              ...(content.text === undefined ? {} : { text: content.text }),
              ...(content.html === undefined ? {} : { html: content.html })
            }
          : {
              template_uuid: content.id,
              ...(content.variables === undefined
                ? {}
                : { template_variables: content.variables })
            }),
        ...(message.headers.length === 0
          ? {}
          : { headers: Object.fromEntries(message.headers) }),
        ...(Object.keys(custom).length === 0
          ? {}
          : { custom_variables: custom }),
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

const errorMessage = (body: unknown): string | undefined => {
  if (body === null || typeof body !== "object") {
    return undefined
  }
  const errors = (body as { errors?: unknown }).errors
  if (typeof errors === "string") {
    return errors
  }
  if (Array.isArray(errors)) {
    return errors.filter((error) => typeof error === "string").join("; ")
  }
  if (errors !== null && typeof errors === "object") {
    const parts = Object.entries(errors as Record<string, unknown>).map(
      ([field, value]) => `${field}: ${String(value)}`
    )
    return parts.join("; ")
  }
  return undefined
}

const readBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<unknown> =>
  response.json.pipe(Effect.orElseSucceed(() => ({})))

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: unknown
): TransportError => {
  const message =
    errorMessage(body) ??
    `Mailtrap request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "mailtrap",
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

const missingId = (body: unknown, status: number): TransportError =>
  MalformedProviderResponse.new({
    message: "Mailtrap success response did not contain a message id",
    provider: "mailtrap",
    status,
    cause: body
  })

const makeSend = (
  client: HttpClient.HttpClient,
  options: MailtrapOptions
) => {
  const endpoint = (options.baseUrl ?? "https://send.api.mailtrap.io").replace(/\/$/, "")
  const sandboxEndpoint = (
    options.sandboxBaseUrl ?? "https://sandbox.api.mailtrap.io"
  ).replace(/\/$/, "")
  const bulkEndpoint = (options.bulkBaseUrl ?? "https://bulk.api.mailtrap.io").replace(/\/$/, "")

  const inboxPath = (): string => {
    if (options.inboxId === undefined) {
      return ""
    }
    const value = String(options.inboxId).trim()
    return value.length === 0 ? "" : `/${value}`
  }

  const urlFor = (sandbox: boolean, kind: "send" | "batch"): string => {
    if (sandbox) {
      return `${sandboxEndpoint}/api/${kind}${inboxPath()}`
    }
    const host = options.bulk === true ? bulkEndpoint : endpoint
    return `${host}/api/${kind}`
  }

  const execute = (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
    client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "Mailtrap request failed before a response was received; outcome is unknown",
            provider: "mailtrap",
            cause
          })
      )
    )

  const requestFor = (
    sandbox: boolean,
    kind: "send" | "batch",
    body: unknown
  ): HttpClientRequest.HttpClientRequest =>
    pipe(
      HttpClientRequest.post(urlFor(sandbox, kind)),
      HttpClientRequest.setHeader(
        "Api-Token",
        Redacted.value(options.apiKey)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      options.userAgent === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("User-Agent", options.userAgent),
      HttpClientRequest.bodyJsonUnsafe(body)
    )

  const sendEmail = Effect.fn("Mailtrap.sendEmail")(function* (
    payload: MailtrapPayload,
    sandbox: boolean
  ): Effect.fn.Return<MailtrapSendResult, TransportError> {
    const response = yield* execute(requestFor(sandbox, "send", payload))
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readBody(response))
    }
    const body = yield* readBody(response)
    const decoded = yield* Schema.decodeUnknownEffect(MailtrapSendResponse)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Mailtrap returned an unreadable success response",
            provider: "mailtrap",
            status: response.status,
            cause
          })
      )
    )
    if (decoded.success === false) {
      return yield* ProviderRejected.new({
        message: errorMessage(body) ?? "Mailtrap reported a failed send",
        provider: "mailtrap",
        status: response.status,
        retryable: false
      })
    }
    const id = decoded.message_ids?.[0]
    if (id === undefined) {
      return yield* missingId(body, response.status)
    }
    return { id: providerMessageId(id) }
  })

  const sendBatch = Effect.fn("Mailtrap.sendBatch")(function* (
    payloads: ReadonlyArray<MailtrapPayload>,
    sandbox: boolean
  ): Effect.fn.Return<MailtrapBatchResult, TransportError> {
    const body = {
      ...(payloads[0] === undefined ? {} : { base: { from: payloads[0].from } }),
      requests: payloads
    }
    const response = yield* execute(requestFor(sandbox, "batch", body))
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readBody(response))
    }
    const raw = yield* readBody(response)
    const decoded = yield* Schema.decodeUnknownEffect(MailtrapBatchResponse)(
      raw
    ).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Mailtrap returned an unreadable batch response",
            provider: "mailtrap",
            status: response.status,
            cause
          })
      )
    )
    const entries = decoded.responses ?? []
    return {
      ids: payloads.map((_, index) => {
        const entry = entries[index]
        if (entry === null || typeof entry !== "object") {
          return undefined
        }
        const decodedEntry = Schema.decodeUnknownOption(MailtrapSendResponse)(
          entry
        )
        if (
          Option.isNone(decodedEntry) ||
          decodedEntry.value.success === false
        ) {
          return undefined
        }
        const id = decodedEntry.value.message_ids?.[0]
        return id === undefined ? undefined : providerMessageId(id)
      })
    }
  })

  return { sendEmail, sendBatch }
}

const receiptFor = (
  envelope: PreparedEnvelope,
  destinationIdValue: ReturnType<typeof destinationId>,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "mailtrap",
  destinationId: destinationIdValue,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

const makeTransport = (
  options: MailtrapOptions,
  sendEmail: MailtrapClient["sendEmail"],
  sendBatch: MailtrapClient["sendBatch"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "mailtrap",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)
  const defaultCategory = options.defaultCategory ?? "general"
  const sandboxFor = (): boolean => options.sandbox === true

  const validateSandbox = (): Effect.Effect<void, UnsupportedCapability> => {
    if (
      sandboxFor() &&
      (options.inboxId === undefined ||
        String(options.inboxId).trim().length === 0)
    ) {
      return Effect.fail(
        UnsupportedCapability.new({
          message: "Mailtrap sandbox requires an inboxId",
          provider: "mailtrap",
          capability: "sandbox"
        })
      )
    }
    return Effect.void
  }

  const send = Effect.fn("Mailtrap.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    yield* validateSandbox()
    const payload = yield* payloadFor(envelope.message, defaultCategory)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload, sandboxFor())
    return receiptFor(envelope, resolvedDestinationId, result.id, acceptedAt)
  })

  const sendBatchOutcomes: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Mailtrap.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const payloads: Array<MailtrapPayload> = []
    const slots: Array<number> = []
    const sandbox = sandboxFor()
    const sandboxError =
      sandbox &&
      (options.inboxId === undefined ||
        String(options.inboxId).trim().length === 0)
        ? UnsupportedCapability.new({
            message: "Mailtrap sandbox requires an inboxId",
            provider: "mailtrap",
            capability: "sandbox"
          })
        : undefined

    for (const [index, envelope] of envelopes.entries()) {
      if (sandboxError !== undefined) {
        outcomes[index] = { _tag: "rejected", index, error: sandboxError }
        continue
      }
      const result = yield* Effect.result(
        payloadFor(envelope.message, defaultCategory)
      )
      if (result._tag === "Failure") {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
      } else {
        payloads.push(result.success)
        slots.push(index)
      }
    }

    if (payloads.length === 0) {
      return outcomes
    }

    const acceptedAt = yield* DateTime.now
    const result = yield* Effect.result(sendBatch(payloads, sandbox))
    if (result._tag === "Failure") {
      for (const index of slots) {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
      }
      return outcomes
    }

    for (const [offset, index] of slots.entries()) {
      const id = result.success.ids[offset]
      outcomes[index] =
        id === undefined
          ? {
              _tag: "uncertain",
              index,
              error: MalformedProviderResponse.new({
                message:
                  "Mailtrap batch response did not contain an id for this message",
                provider: "mailtrap"
              })
            }
          : {
              _tag: "accepted",
              index,
              receipt: receiptFor(
                envelopes[index]!,
                resolvedDestinationId,
                id,
                acceptedAt
              )
            }
    }

    return outcomes
  })

  return {
    destination,
    capabilities: capabilities as NativeBatchTransport["capabilities"],
    send,
    sendBatch: sendBatchOutcomes
  }
}

export const makeClient = (
  options: MailtrapOptions
): Effect.Effect<MailtrapClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const { sendEmail, sendBatch } = makeSend(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail, sendBatch),
      sendEmail,
      sendBatch
    }
  })

export const make = (
  options: MailtrapOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailtrapOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailtrapOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailtrapOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailtrapOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("MAILTRAP_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailtrap", account })
