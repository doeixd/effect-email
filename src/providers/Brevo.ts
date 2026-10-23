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
  DeliveryStatus,
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

export interface BrevoOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
}

export interface BrevoSendResult {
  readonly id: ProviderMessageId
}

export interface BrevoBatchResult {
  readonly ids: ReadonlyArray<ProviderMessageId>
}

export interface BrevoRequestOptions {
  readonly idempotencyKey?: string
}

export interface BrevoClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: BrevoPayload,
    options?: BrevoRequestOptions
  ) => Effect.Effect<BrevoSendResult, TransportError>
  readonly sendMessageVersions: (
    payload: BrevoPayload,
    options?: BrevoRequestOptions
  ) => Effect.Effect<BrevoBatchResult, TransportError>
  readonly retrieve: (
    id: ProviderMessageId
  ) => Effect.Effect<DeliveryStatus, TransportError>
  readonly cancel: (
    id: ProviderMessageId
  ) => Effect.Effect<void, TransportError>
}

export class Client extends Context.Service<Client, BrevoClient>()(
  "@effect-email/providers/Brevo/Client"
) {}

export interface BrevoAddress {
  readonly email: string
  readonly name?: string
}

export interface BrevoAttachment {
  readonly name: string
  readonly content: string
}

export interface BrevoVersion {
  readonly to: ReadonlyArray<BrevoAddress>
  readonly cc?: ReadonlyArray<BrevoAddress>
  readonly bcc?: ReadonlyArray<BrevoAddress>
  readonly replyTo?: BrevoAddress
  readonly subject: string
  readonly htmlContent?: string
  readonly textContent?: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface BrevoPayload {
  readonly sender: BrevoAddress
  readonly to?: ReadonlyArray<BrevoAddress>
  readonly cc?: ReadonlyArray<BrevoAddress>
  readonly bcc?: ReadonlyArray<BrevoAddress>
  readonly replyTo?: BrevoAddress
  readonly subject?: string
  readonly htmlContent?: string
  readonly textContent?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly tags?: ReadonlyArray<string>
  readonly templateId?: number
  readonly params?: Readonly<Record<string, unknown>>
  readonly attachment?: ReadonlyArray<BrevoAttachment>
  readonly messageVersions?: ReadonlyArray<BrevoVersion>
}

export const BrevoSuccess = Schema.Struct({
  messageId: Schema.optionalKey(Schema.NonEmptyString),
  messageIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})

export const BrevoStatusEntry = Schema.Struct({
  createdAt: Schema.optionalKey(Schema.String),
  scheduledAt: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String)
})

export const BrevoStatusResponse = Schema.Struct({
  createdAt: Schema.optionalKey(Schema.String),
  scheduledAt: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  batches: Schema.optionalKey(Schema.Array(BrevoStatusEntry))
})

export const BrevoErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String)
})

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 1000,
  maxRecipientsPerMessage: 99,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "request"
})

const RECIPIENTS_PER_VERSION = 99
const RECIPIENTS_PER_REQUEST = 2000

const formatAddress = (address: NormalizedAddress): BrevoAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<BrevoAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "Brevo does not accept remote attachment URLs",
        provider: "brevo",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "Brevo adapter cannot read attachments from local paths; provide bytes instead",
        provider: "brevo",
        capability: "attachments"
      })
    )
  }
  const content =
    attachment.source.encoding === "base64"
      ? new TextDecoder().decode(attachment.source.content)
      : Base64.encode(attachment.source.content)
  return Effect.succeed({ name: attachment.filename, content })
}

const contentFor = (
  message: PreparedMessage
): Effect.Effect<
  {
    readonly htmlContent?: string
    readonly textContent?: string
    readonly templateId?: number
    readonly params?: Readonly<Record<string, unknown>>
  },
  TransportError
> => {
  const content = message.content
  switch (content._tag) {
    case "rendered":
      return Effect.succeed({
        ...(content.html === undefined ? {} : { htmlContent: content.html }),
        ...(content.text === undefined ? {} : { textContent: content.text })
      })
    case "provider-template":
      if (!/^\d+$/.test(content.id)) {
        return Effect.fail(
          UnsupportedCapability.new({
            message: `Brevo templates use numeric ids, received ${content.id}`,
            provider: "brevo",
            capability: "provider-templates"
          })
        )
      }
      return Effect.succeed({
        templateId: Number(content.id),
        ...(content.variables === undefined
          ? {}
          : { params: content.variables })
      })
    default:
      return Effect.fail(
        UnsupportedCapability.new({
          message: `Brevo adapter does not support ${content._tag} content`,
          provider: "brevo",
          capability: content._tag === "raw" ? "raw-mime" : "local-templates"
        })
      )
  }
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<BrevoPayload, TransportError> => {
  if (message.to.length > RECIPIENTS_PER_VERSION) {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `Brevo accepts at most ${RECIPIENTS_PER_VERSION} to recipients, got ${message.to.length}`,
        provider: "brevo",
        capability: "recipients"
      })
    )
  }
  return Effect.gen(function* () {
    const content = yield* contentFor(message)
    const attachments = yield* Effect.forEach(
      message.attachments,
      attachmentFor
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
      ...(message.replyTo[0] === undefined
        ? {}
        : { replyTo: formatAddress(message.replyTo[0]) }),
      subject: message.subject,
      ...content,
      ...(message.headers.length === 0
        ? {}
        : { headers: Object.fromEntries(message.headers) }),
      ...(message.tags.length === 0 ? {} : { tags: [...message.tags] }),
      ...(attachments.length === 0 ? {} : { attachment: attachments })
    }
  })
}

const versionFor = (
  payload: BrevoPayload
): BrevoVersion => ({
  to: payload.to ?? [],
  ...(payload.cc === undefined ? {} : { cc: payload.cc }),
  ...(payload.bcc === undefined ? {} : { bcc: payload.bcc }),
  ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
  subject: payload.subject ?? "",
  ...(payload.htmlContent === undefined
    ? {}
    : { htmlContent: payload.htmlContent }),
  ...(payload.textContent === undefined
    ? {}
    : { textContent: payload.textContent }),
  ...(payload.params === undefined ? {} : { params: payload.params })
})

const attachmentFingerprint = (attachment: Attachment): string =>
  attachment.source._tag === "content"
    ? `${attachment.filename}:${attachment.contentType ?? ""}:content:${
        attachment.source.encoding ?? "binary"
      }:${Base64.encode(attachment.source.content)}:${
        attachment.contentId ?? ""
      }`
    : `${attachment.filename}:${attachment.contentType ?? ""}:${
        attachment.source._tag
      }:${
        attachment.source._tag === "url"
          ? attachment.source.url
          : attachment.source.path
      }:${attachment.contentId ?? ""}`

const sharedEnvelope = (message: PreparedMessage): string =>
  JSON.stringify([
    message.from,
    message.headers,
    message.tags,
    message.content._tag,
    message.content._tag === "provider-template"
      ? message.content.id
      : undefined,
    message.attachments.map(attachmentFingerprint)
  ])

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
): Effect.Effect<typeof BrevoErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(BrevoErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const AUTH_CODES = new Set(["unauthorized", "permission_denied"])

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof BrevoErrorBody.Type
): TransportError => {
  const message =
    body.message ?? `Brevo request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "brevo",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    (body.code !== undefined && AUTH_CODES.has(body.code))
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

const execute = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
  client.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        DeliveryUncertain.new({
          message: "Brevo request failed before a response was received; outcome is unknown",
          provider: "brevo",
          cause
        })
    )
  )

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const idempotencyKeyFor = (
  keys: ReadonlyArray<string | undefined>
): Effect.Effect<string | undefined> => {
  const present = [...new Set(
    keys.filter((key): key is string => key !== undefined)
  )]
  if (present.length === 0) {
    return Effect.succeed(undefined)
  }
  const key = present.length === 1 ? present[0]! : present.join("\n")
  if (UUID.test(key)) {
    return Effect.succeed(key)
  }
  return Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key)
    )
    const bytes = new Uint8Array(digest)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = [...bytes.subarray(0, 16)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32)
    ].join("-")
  })
}

const requestFor = (
  baseUrl: string,
  apiKey: Redacted.Redacted<string>,
  payload: BrevoPayload,
  options: BrevoRequestOptions
): HttpClientRequest.HttpClientRequest => {
  const body =
    options.idempotencyKey === undefined
      ? payload
      : {
          ...payload,
          headers: {
            ...payload.headers,
            idempotencyKey: options.idempotencyKey
          }
        }
  return pipe(
    HttpClientRequest.post(`${baseUrl}/v3/smtp/email`),
    HttpClientRequest.setHeader("api-key", Redacted.value(apiKey)),
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.setHeader("Accept", "application/json"),
    HttpClientRequest.bodyJsonUnsafe(body)
  )
}

const makeSend = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) => {
  const sendEmail = Effect.fn("Brevo.sendEmail")(function* (
    payload: BrevoPayload,
    options: BrevoRequestOptions = {}
  ): Effect.fn.Return<BrevoSendResult, TransportError> {
    const request = requestFor(baseUrl, apiKey, payload, options)
    const response = yield* execute(client, request)
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Brevo returned an unreadable success response",
            provider: "brevo",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(BrevoSuccess)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Brevo success response did not contain a messageId",
            provider: "brevo",
            status: response.status,
            cause
          })
      )
    )
    const id = decoded.messageId ?? decoded.messageIds?.[0]
    if (id === undefined) {
      return yield* MalformedProviderResponse.new({
        message: "Brevo success response did not contain a messageId",
        provider: "brevo",
        status: response.status,
        cause: body
      })
    }
    return { id: providerMessageId(id) }
  })

  const sendMessageVersions = Effect.fn("Brevo.sendMessageVersions")(
    function* (
      payload: BrevoPayload,
      options: BrevoRequestOptions = {}
    ): Effect.fn.Return<BrevoBatchResult, TransportError> {
      const request = requestFor(baseUrl, apiKey, payload, options)
      const response = yield* execute(client, request)
      if (response.status < 200 || response.status >= 300) {
        const body = yield* readErrorBody(response)
        return yield* classifyFailure(response, body)
      }
      const body = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            MalformedProviderResponse.new({
              message: "Brevo returned an unreadable batch response",
              provider: "brevo",
              status: response.status,
              cause
            })
        )
      )
      const decoded = yield* Schema.decodeUnknownEffect(BrevoSuccess)(
        body
      ).pipe(
        Effect.mapError(
          (cause) =>
            MalformedProviderResponse.new({
              message: "Brevo batch response did not contain messageIds",
              provider: "brevo",
              status: response.status,
              cause
            })
        )
      )
      return {
        ids: (decoded.messageIds ?? []).map(providerMessageId)
      }
    }
  )

  const readRequest = (
    url: string,
    method: "GET" | "DELETE"
  ): HttpClientRequest.HttpClientRequest =>
    pipe(
      HttpClientRequest.make(method)(url),
      HttpClientRequest.setHeader("api-key", Redacted.value(apiKey)),
      HttpClientRequest.setHeader("Accept", "application/json")
    )

  const retrieve = Effect.fn("Brevo.retrieve")(function* (
    id: ProviderMessageId
  ): Effect.fn.Return<DeliveryStatus, TransportError> {
    const response = yield* execute(
      client,
      readRequest(
        `${baseUrl}/v3/smtp/emailStatus/${encodeURIComponent(id)}`,
        "GET"
      )
    )
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Brevo returned an unreadable status response",
            provider: "brevo",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(BrevoStatusResponse)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Brevo status response had an unexpected shape",
            provider: "brevo",
            status: response.status,
            cause
          })
      )
    )
    const entry = decoded.batches?.[0] ?? decoded
    const at = entry.scheduledAt ?? entry.createdAt
    return {
      providerMessageId: id,
      provider: "brevo",
      state: toDeliveryState(entry.status),
      ...(at === undefined
        ? {}
        : { at: DateTime.makeUnsafe(new Date(at)) })
    }
  })

  const cancel = Effect.fn("Brevo.cancel")(function* (
    id: ProviderMessageId
  ): Effect.fn.Return<void, TransportError> {
    const response = yield* execute(
      client,
      readRequest(
        `${baseUrl}/v3/smtp/email/${encodeURIComponent(id)}`,
        "DELETE"
      )
    )
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }
  })

  return { sendEmail, sendMessageVersions, retrieve, cancel }
}

const receiptFor = (
  envelope: PreparedEnvelope,
  destinationIdValue: ReturnType<typeof destinationId>,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "brevo",
  destinationId: destinationIdValue,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

const groupByEnvelope = (
  entries: ReadonlyArray<{ readonly index: number; readonly payload: BrevoPayload; readonly signature: string }>
): ReadonlyArray<
  ReadonlyArray<{ readonly index: number; readonly payload: BrevoPayload }>
> => {
  const groups = new Map<
    string,
    Array<{ readonly index: number; readonly payload: BrevoPayload }>
  >()
  for (const entry of entries) {
    const group = groups.get(entry.signature)
    if (group === undefined) {
      groups.set(entry.signature, [{ index: entry.index, payload: entry.payload }])
    } else {
      group.push({ index: entry.index, payload: entry.payload })
    }
  }
  return [...groups.values()]
}

const splitByRecipients = <T extends { readonly payload: BrevoPayload }>(
  entries: ReadonlyArray<T>
): ReadonlyArray<ReadonlyArray<T>> => {
  const groups: Array<Array<T>> = []
  let current: Array<T> = []
  let recipients = 0
  for (const entry of entries) {
    const size =
      (entry.payload.to?.length ?? 0) +
      (entry.payload.cc?.length ?? 0) +
      (entry.payload.bcc?.length ?? 0)
    if (current.length > 0 && recipients + size > RECIPIENTS_PER_REQUEST) {
      groups.push(current)
      current = []
      recipients = 0
    }
    current.push(entry)
    recipients += size
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

const makeTransport = (
  options: BrevoOptions,
  sendEmail: BrevoClient["sendEmail"],
  sendMessageVersions: BrevoClient["sendMessageVersions"],
  retrieve: BrevoClient["retrieve"],
  cancel: BrevoClient["cancel"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "brevo",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Brevo.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message)
    const idempotencyKey = yield* idempotencyKeyFor([
      envelope.providerIdempotencyKey
    ])
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload, { idempotencyKey })
    return receiptFor(envelope, resolvedDestinationId, result.id, acceptedAt)
  })

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Brevo.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const sendable: Array<{
      readonly index: number
      readonly payload: BrevoPayload
      readonly signature: string
    }> = []

    for (const [index, envelope] of envelopes.entries()) {
      const result = yield* Effect.result(payloadFor(envelope.message))
      if (result._tag === "Failure") {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
      } else {
        sendable.push({
          index,
          payload: result.success,
          signature: sharedEnvelope(envelope.message)
        })
      }
    }

    for (const group of groupByEnvelope(sendable)) {
      for (const chunk of splitByRecipients(group)) {
        const first = chunk[0]!
        const {
          to: _to,
          cc: _cc,
          bcc: _bcc,
          replyTo: _replyTo,
          subject: _subject,
          htmlContent: _htmlContent,
          textContent: _textContent,
          params: _params,
          ...base
        } = first.payload
        const payload: BrevoPayload = {
          ...base,
          messageVersions: chunk.map((entry) => versionFor(entry.payload))
        }

        const idempotencyKey = yield* idempotencyKeyFor(
          chunk.map((entry) => {
            const envelope = envelopes[entry.index]!
            return envelope.providerIdempotencyKey === undefined
              ? undefined
              : `${envelope.providerIdempotencyKey}:${envelope.deliveryId}`
          })
        )
        const acceptedAt = yield* DateTime.now
        const result = yield* Effect.result(
          sendMessageVersions(payload, { idempotencyKey })
        )
        if (result._tag === "Failure") {
          for (const entry of chunk) {
            outcomes[entry.index] =
              certaintyOf(result.failure) === "unknown"
                ? { _tag: "uncertain", index: entry.index, error: result.failure }
                : { _tag: "rejected", index: entry.index, error: result.failure }
          }
          continue
        }
        for (const [offset, entry] of chunk.entries()) {
          const id = result.success.ids[offset]
          outcomes[entry.index] =
            id === undefined
              ? {
                  _tag: "uncertain",
                  index: entry.index,
                  error: MalformedProviderResponse.new({
                    message:
                      "Brevo batch response did not contain an id for this message",
                    provider: "brevo"
                  })
                }
              : {
                  _tag: "accepted",
                  index: entry.index,
                  receipt: receiptFor(
                    envelopes[entry.index]!,
                    resolvedDestinationId,
                    id,
                    acceptedAt
                  )
                }
        }
      }
    }

    return outcomes
  })

  const retrieveReceipt: NonNullable<Transport["retrieve"]> = (receipt) => {
    const id = receipt.providerMessageId
    if (id === undefined) {
      return Effect.fail(
        UnsupportedCapability.new({
          message: "Brevo retrieval requires a provider message id",
          provider: "brevo",
          capability: "retrieve"
        })
      )
    }
    return retrieve(id)
  }

  const cancelReceipt: NonNullable<Transport["cancel"]> = (receipt) => {
    const id = receipt.providerMessageId
    if (id === undefined) {
      return Effect.fail(
        UnsupportedCapability.new({
          message: "Brevo cancellation requires a provider message id",
          provider: "brevo",
          capability: "cancel"
        })
      )
    }
    return cancel(id)
  }

  return {
    destination,
    capabilities: capabilities as NativeBatchTransport["capabilities"],
    send,
    sendBatch,
    retrieve: retrieveReceipt,
    cancel: cancelReceipt
  }
}

export const makeClient = (
  options: BrevoOptions
): Effect.Effect<BrevoClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? "https://api.brevo.com"
    const { sendEmail, sendMessageVersions, retrieve, cancel } = makeSend(
      httpClient,
      options.apiKey,
      baseUrl
    )
    return {
      transport: makeTransport(
        options,
        sendEmail,
        sendMessageVersions,
        retrieve,
        cancel
      ),
      sendEmail,
      sendMessageVersions,
      retrieve,
      cancel
    }
  })

const toDeliveryState = (
  status: string | undefined
): DeliveryStatus["state"] => {
  switch (status) {
    case "queued":
      return "queued"
    case "inProgress":
      return "queued"
    case "processed":
      return "sent"
    case "error":
      return "failed"
    default:
      return "unknown"
  }
}

export const make = (
  options: BrevoOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: BrevoOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: BrevoOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: BrevoOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<BrevoOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("BREVO_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "brevo", account })

