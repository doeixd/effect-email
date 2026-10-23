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

export interface ZeptomailOptions {
  readonly token: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly bounceAddress?: string
  readonly clientReference?: string
  readonly trackClicks?: boolean
  readonly trackOpens?: boolean
  readonly account?: string
}

export interface ZeptomailSendResult {
  readonly id: ProviderMessageId
}

export interface ZeptomailClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: ZeptomailPayload,
    templated: boolean
  ) => Effect.Effect<ZeptomailSendResult, TransportError>
  readonly sendBatch: (
    payload: ZeptomailBatchPayload,
    templated: boolean
  ) => Effect.Effect<ZeptomailSendResult, TransportError>
}

export class Client extends Context.Service<Client, ZeptomailClient>()(
  "@effect-email/providers/Zeptomail/Client"
) {}

export interface ZeptomailAddress {
  readonly address: string
  readonly name?: string
}

export interface ZeptomailRecipient {
  readonly email_address: ZeptomailAddress
  readonly merge_info?: Readonly<Record<string, unknown>>
}

export interface ZeptomailAttachment {
  readonly name: string
  readonly content: string
  readonly mime_type: string
}

export interface ZeptomailInline {
  readonly cid: string
  readonly content: string
  readonly mime_type: string
}

export interface ZeptomailPayload {
  readonly from: ZeptomailAddress
  readonly to: ReadonlyArray<ZeptomailRecipient>
  readonly cc?: ReadonlyArray<ZeptomailRecipient>
  readonly bcc?: ReadonlyArray<ZeptomailRecipient>
  readonly reply_to?: ReadonlyArray<ZeptomailAddress>
  readonly subject: string
  readonly textbody?: string
  readonly htmlbody?: string
  readonly mime_headers?: Readonly<Record<string, string>>
  readonly client_reference?: string
  readonly bounce_address?: string
  readonly track_clicks?: boolean
  readonly track_opens?: boolean
  readonly attachments?: ReadonlyArray<ZeptomailAttachment>
  readonly inline_images?: ReadonlyArray<ZeptomailInline>
  readonly template_key?: string
  readonly merge_info?: Readonly<Record<string, unknown>>
}

export interface ZeptomailBatchPayload {
  readonly from: ZeptomailAddress
  readonly to: ReadonlyArray<ZeptomailRecipient>
  readonly reply_to?: ReadonlyArray<ZeptomailAddress>
  readonly subject: string
  readonly textbody?: string
  readonly htmlbody?: string
  readonly mime_headers?: Readonly<Record<string, string>>
  readonly client_reference?: string
  readonly bounce_address?: string
  readonly track_clicks?: boolean
  readonly track_opens?: boolean
  readonly attachments?: ReadonlyArray<ZeptomailAttachment>
  readonly inline_images?: ReadonlyArray<ZeptomailInline>
  readonly template_key?: string
}

export const ZeptomailSuccess = Schema.Struct({
  request_id: Schema.optionalKey(Schema.NonEmptyString),
  message: Schema.optionalKey(Schema.String),
  object: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      request_id: Schema.optionalKey(Schema.String),
      details: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            code: Schema.optionalKey(Schema.String),
            message: Schema.optionalKey(Schema.String),
            target: Schema.optionalKey(Schema.String)
          })
        )
      )
    })
  )
})
type ZeptomailBody = typeof ZeptomailSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 500,
  maxRecipientsPerMessage: 500,
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

const TOKEN_PREFIX = "Zoho-enczapikey "
const BATCH_ADDRESS_LIMIT = 500
const RECIPIENT_LIMIT = 500
const ATTACHMENT_LIMIT = 60
const SUBJECT_LIMIT = 500
const REFERENCE_TAG = "client_reference"

const AUTH_DETAIL_CODES = new Set(["SERR_156", "SERR_157", "SM_111", "SM_128", "AE_101"])
const RATE_DETAIL_CODES = new Set(["SM_133", "SMI_115"])
const EXHAUSTED_DETAIL_CODES = new Set(["LE_101", "LE_102"])
const INVALID_CODES = new Set(["TM_3201", "TM_3301", "TM_8001"])

const formatAddress = (address: NormalizedAddress): ZeptomailAddress =>
  address.name === undefined
    ? { address: address.address }
    : { address: address.address, name: address.name }

const recipientFor = (
  address: NormalizedAddress,
  mergeInfo?: Readonly<Record<string, unknown>>
): ZeptomailRecipient => ({
  email_address: formatAddress(address),
  ...(mergeInfo === undefined ? {} : { merge_info: mergeInfo })
})

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<ZeptomailAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "ZeptoMail does not accept remote attachment URLs",
        provider: "zeptomail",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "ZeptoMail adapter cannot read attachments from local paths; provide bytes instead",
        provider: "zeptomail",
        capability: "attachments"
      })
    )
  }
  const content =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({
    name: attachment.filename,
    content,
    mime_type: attachment.contentType ?? "application/octet-stream"
  })
}

const sharedFor = (
  message: PreparedMessage,
  options: ZeptomailOptions
): Effect.Effect<
  Omit<ZeptomailBatchPayload, "to">,
  TransportError
> => {
  if (message.to.length > RECIPIENT_LIMIT) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `ZeptoMail accepts at most ${RECIPIENT_LIMIT} to recipients, got ${message.to.length}`,
        provider: "zeptomail",
        capability: "recipients"
      })
    )
  }
  if (message.attachments.length > ATTACHMENT_LIMIT) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `ZeptoMail accepts at most ${ATTACHMENT_LIMIT} attachments, got ${message.attachments.length}`,
        provider: "zeptomail",
        capability: "attachments"
      })
    )
  }
  if (message.subject.length > SUBJECT_LIMIT) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `ZeptoMail accepts subjects up to ${SUBJECT_LIMIT} characters`,
        provider: "zeptomail",
        capability: "subject"
      })
    )
  }

  const content = message.content
  if (content._tag !== "rendered" && content._tag !== "provider-template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `ZeptoMail adapter does not support ${content._tag} content`,
        provider: "zeptomail",
        capability: content._tag === "raw" ? "raw-mime" : "local-templates"
      })
    )
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

  return Effect.gen(function* () {
    const attachments = yield* Effect.forEach(files, attachmentFor)
    const inlineImages = yield* Effect.forEach(inlines, (attachment) =>
      Effect.map(
        attachmentFor(attachment),
        (file): ZeptomailInline => ({
          cid: attachment.contentId ?? attachment.filename,
          content: file.content,
          mime_type: file.mime_type
        })
      )
    )
    const headers: Record<string, string> = Object.fromEntries(message.headers)
    for (const tag of message.tags) {
      headers[`X-Tag-${tag}`] = "true"
    }
    const referenceTag = message.tags.includes(REFERENCE_TAG)
      ? REFERENCE_TAG
      : undefined
    return {
      from: formatAddress(message.from),
      ...(message.replyTo.length === 0
        ? {}
        : { reply_to: message.replyTo.map(formatAddress) }),
      subject: message.subject,
      ...(content._tag === "rendered"
        ? {
            ...(content.text === undefined ? {} : { textbody: content.text }),
            ...(content.html === undefined ? {} : { htmlbody: content.html })
          }
        : { template_key: content.id }),
      ...(Object.keys(headers).length === 0 ? {} : { mime_headers: headers }),
      ...(options.clientReference === undefined && referenceTag === undefined
        ? {}
        : { client_reference: options.clientReference ?? REFERENCE_TAG }),
      ...(options.bounceAddress === undefined
        ? {}
        : { bounce_address: options.bounceAddress }),
      ...(options.trackClicks === undefined
        ? {}
        : { track_clicks: options.trackClicks }),
      ...(options.trackOpens === undefined
        ? {}
        : { track_opens: options.trackOpens }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(inlineImages.length === 0 ? {} : { inline_images: inlineImages })
    }
  })
}

const payloadFor = (
  message: PreparedMessage,
  options: ZeptomailOptions
): Effect.Effect<ZeptomailPayload, TransportError> =>
  Effect.map(sharedFor(message, options), (shared) => ({
    ...shared,
    to: message.to.map((address) =>
      recipientFor(
        address,
        message.content._tag === "provider-template"
          ? message.content.variables
          : undefined
      )
    ),
    ...(message.cc.length === 0
      ? {}
      : { cc: message.cc.map((address) => recipientFor(address)) }),
    ...(message.bcc.length === 0
      ? {}
      : { bcc: message.bcc.map((address) => recipientFor(address)) })
  }))

const headerValue = (
  response: HttpClientResponse.HttpClientResponse,
  name: string
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, name))

const readBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<ZeptomailBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(ZeptomailSuccess)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: ZeptomailBody
): TransportError => {
  const error = body.error
  const detail = error?.details?.[0]
  const message = [error?.message, detail?.message, detail?.target]
    .filter((part): part is string => typeof part === "string")
    .join(": ")
  const retryAfterMillis = (() => {
    const value = headerValue(response, "retry-after")
    if (value === undefined) {
      return undefined
    }
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : undefined
  })()
  const common = {
    message:
      message.length === 0
        ? `ZeptoMail request failed with status ${response.status}`
        : message,
    provider: "zeptomail",
    status: response.status,
    ...(body.request_id === undefined && error?.request_id === undefined
      ? {}
      : { requestId: error?.request_id ?? body.request_id }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (detail?.code !== undefined && AUTH_DETAIL_CODES.has(detail.code)) {
    return AuthenticationFailed.new(common)
  }
  if (detail?.code !== undefined && RATE_DETAIL_CODES.has(detail.code)) {
    return RateLimited.new({ ...common, retryable: true })
  }
  if (detail?.code !== undefined && EXHAUSTED_DETAIL_CODES.has(detail.code)) {
    return ProviderRejected.new({ ...common, retryable: false })
  }
  if (error?.code !== undefined && INVALID_CODES.has(error.code)) {
    return ProviderRejected.new({ ...common, retryable: false })
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

const makeSend = (
  client: HttpClient.HttpClient,
  options: ZeptomailOptions
) => {
  const endpoint = (options.baseUrl ?? "https://api.zeptomail.com").replace(/\/$/, "")
  const provided = Redacted.value(options.token)
  const token = provided.toLowerCase().startsWith(TOKEN_PREFIX.toLowerCase())
    ? provided
    : `${TOKEN_PREFIX}${provided}`

  const execute = (
    path: string,
    body: unknown
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> => {
    const request = pipe(
      HttpClientRequest.post(`${endpoint}/v1.1${path}`),
      HttpClientRequest.setHeader("Authorization", token),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(body)
    )
    return client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "ZeptoMail request failed before a response was received; outcome is unknown",
            provider: "zeptomail",
            cause
          })
      )
    )
  }

  const finish = (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<ZeptomailSendResult, TransportError> =>
    Effect.gen(function* () {
      if (response.status < 200 || response.status >= 300) {
        return yield* classifyFailure(response, yield* readBody(response))
      }
      const raw = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            MalformedProviderResponse.new({
              message: "ZeptoMail returned an unreadable success response",
              provider: "zeptomail",
              status: response.status,
              cause
            })
        )
      )
      const body = yield* Schema.decodeUnknownEffect(ZeptomailSuccess)(raw).pipe(
        Effect.mapError(
          (cause) =>
            MalformedProviderResponse.new({
              message: "ZeptoMail returned an unreadable success response",
              provider: "zeptomail",
              status: response.status,
              cause
            })
        )
      )
      if (body.request_id === undefined) {
        return yield* MalformedProviderResponse.new({
          message: "ZeptoMail response did not contain a request_id",
          provider: "zeptomail",
          status: response.status,
          cause: raw
        })
      }
      return { id: providerMessageId(body.request_id) }
    })

  const sendEmail = Effect.fn("Zeptomail.sendEmail")(function* (
    payload: ZeptomailPayload,
    templated: boolean
  ): Effect.fn.Return<ZeptomailSendResult, TransportError> {
    return yield* finish(
      yield* execute(templated ? "/email/template" : "/email", payload)
    )
  })

  const sendBatch = Effect.fn("Zeptomail.sendBatch")(function* (
    payload: ZeptomailBatchPayload,
    templated: boolean
  ): Effect.fn.Return<ZeptomailSendResult, TransportError> {
    return yield* finish(
      yield* execute(
        templated ? "/email/template/batch" : "/email/batch",
        payload
      )
    )
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
  provider: "zeptomail",
  destinationId: destinationIdValue,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

const splitByAddresses = <T extends { readonly message: PreparedMessage }>(
  entries: ReadonlyArray<T>
): ReadonlyArray<ReadonlyArray<T>> => {
  const groups: Array<Array<T>> = []
  let current: Array<T> = []
  let addresses = 0
  for (const entry of entries) {
    const size = entry.message.to.length
    if (current.length > 0 && addresses + size > BATCH_ADDRESS_LIMIT) {
      groups.push(current)
      current = []
      addresses = 0
    }
    current.push(entry)
    addresses += size
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

const makeTransport = (
  options: ZeptomailOptions,
  sendEmail: ZeptomailClient["sendEmail"],
  sendBatch: ZeptomailClient["sendBatch"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "zeptomail",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Zeptomail.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message, options)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(
      payload,
      envelope.message.content._tag === "provider-template"
    )
    return receiptFor(envelope, resolvedDestinationId, result.id, acceptedAt)
  })

  const sendBatchOutcomes: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Zeptomail.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const groups = new Map<
      string,
      Array<{ readonly index: number; readonly message: PreparedMessage }>
    >()
    const solo: Array<{ readonly index: number; readonly message: PreparedMessage }> = []

    for (const [index, envelope] of envelopes.entries()) {
      const message = envelope.message
      const result = yield* Effect.result(sharedFor(message, options))
      if (result._tag === "Failure") {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
        continue
      }
      if (message.cc.length > 0 || message.bcc.length > 0) {
        solo.push({ index, message })
        continue
      }
      const signature = JSON.stringify(result.success)
      const group = groups.get(signature)
      if (group === undefined) {
        groups.set(signature, [{ index, message }])
      } else {
        group.push({ index, message })
      }
    }

    for (const group of groups.values()) {
      for (const chunk of splitByAddresses(group)) {
        if (chunk.length === 1) {
          const entry = chunk[0]!
          const result = yield* Effect.result(
            payloadFor(entry.message, options).pipe(
              Effect.flatMap((payload) =>
                sendEmail(
                  payload,
                  entry.message.content._tag === "provider-template"
                )
              )
            )
          )
          if (result._tag === "Failure") {
            outcomes[entry.index] =
              certaintyOf(result.failure) === "unknown"
                ? { _tag: "uncertain", index: entry.index, error: result.failure }
                : { _tag: "rejected", index: entry.index, error: result.failure }
          } else {
            const acceptedAt = yield* DateTime.now
            outcomes[entry.index] = {
              _tag: "accepted",
              index: entry.index,
              receipt: receiptFor(
                envelopes[entry.index]!,
                resolvedDestinationId,
                result.success.id,
                acceptedAt
              )
            }
          }
          continue
        }

        const first = chunk[0]!
        const shared = yield* sharedFor(first.message, options)
        const payload: ZeptomailBatchPayload = {
          ...shared,
          to: chunk.flatMap((entry) =>
            entry.message.to.map((address) =>
              recipientFor(
                address,
                entry.message.content._tag === "provider-template"
                  ? entry.message.content.variables
                  : undefined
              )
            )
          )
        }
        const acceptedAt = yield* DateTime.now
        const result = yield* Effect.result(
          sendBatch(
            payload,
            first.message.content._tag === "provider-template"
          )
        )
        for (const entry of chunk) {
          outcomes[entry.index] =
            result._tag === "Failure"
              ? certaintyOf(result.failure) === "unknown"
                ? { _tag: "uncertain", index: entry.index, error: result.failure }
                : { _tag: "rejected", index: entry.index, error: result.failure }
              : {
                  _tag: "accepted",
                  index: entry.index,
                  receipt: receiptFor(
                    envelopes[entry.index]!,
                    resolvedDestinationId,
                    result.success.id,
                    acceptedAt
                  )
                }
        }
      }
    }

    for (const entry of solo) {
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const payload = yield* payloadFor(entry.message, options)
          const acceptedAt = yield* DateTime.now
          const sent = yield* sendEmail(
            payload,
            entry.message.content._tag === "provider-template"
          )
          return { id: sent.id, acceptedAt }
        })
      )
      outcomes[entry.index] =
        result._tag === "Failure"
          ? certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index: entry.index, error: result.failure }
            : { _tag: "rejected", index: entry.index, error: result.failure }
          : {
              _tag: "accepted",
              index: entry.index,
              receipt: receiptFor(
                envelopes[entry.index]!,
                resolvedDestinationId,
                result.success.id,
                result.success.acceptedAt
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
  options: ZeptomailOptions
): Effect.Effect<ZeptomailClient, never, HttpClient.HttpClient> =>
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
  options: ZeptomailOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: ZeptomailOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: ZeptomailOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: ZeptomailOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<ZeptomailOptions, "token"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("ZEPTOMAIL_TOKEN"), (token) =>
      layerTransport({ ...options, token })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "zeptomail", account })
