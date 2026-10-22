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
import type { Destination, DestinationId, ProviderMessageId } from "../Ids"
import { destinationId, makeDestination, providerMessageId } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  certaintyOf,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
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

export interface MailerSendOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
}

export interface MailerSendSendResult {
  readonly id: ProviderMessageId
}

export type MailerSendState =
  | "queued"
  | "sent"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "failed"
  | "unknown"

export interface MailerSendStatus {
  readonly id: ProviderMessageId
  readonly state: MailerSendState
  readonly at?: DateTime.Utc
  readonly provider: unknown
}

export interface MailerSendClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: MailerSendPayload
  ) => Effect.Effect<MailerSendSendResult, TransportError>
  readonly sendBulk: (
    payloads: ReadonlyArray<MailerSendPayload>
  ) => Effect.Effect<ProviderMessageId, TransportError>
  readonly retrieve: (
    id: ProviderMessageId
  ) => Effect.Effect<MailerSendStatus, TransportError>
  readonly retrieveBulk: (
    id: ProviderMessageId
  ) => Effect.Effect<MailerSendStatus, TransportError>
}

export class Client extends Context.Service<Client, MailerSendClient>()(
  "@effect-email/providers/MailerSend/Client"
) {}

export const MailerSendAddress = Schema.Struct({
  email: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NonEmptyString)
})

export interface MailerSendAttachment {
  readonly filename: string
  readonly content: string
  readonly disposition?: "attachment" | "inline"
  readonly id?: string
}

export const MailerSendPayload = Schema.Struct({
  from: MailerSendAddress,
  to: Schema.Array(MailerSendAddress),
  cc: Schema.optionalKey(Schema.Array(MailerSendAddress)),
  bcc: Schema.optionalKey(Schema.Array(MailerSendAddress)),
  reply_to: Schema.optionalKey(MailerSendAddress),
  subject: Schema.String,
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        value: Schema.String
      })
    )
  ),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        filename: Schema.NonEmptyString,
        content: Schema.String,
        disposition: Schema.optionalKey(
          Schema.Literals(["attachment", "inline"])
        ),
        id: Schema.optionalKey(Schema.NonEmptyString)
      })
    )
  )
})
export type MailerSendPayload = typeof MailerSendPayload.Type

export const MailerSendSuccess = Schema.Struct({
  bulk_email_id: Schema.optionalKey(Schema.NonEmptyString),
  message_id: Schema.optionalKey(Schema.NonEmptyString)
})

export const MailerSendMessageStatus = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      created_at: Schema.optionalKey(Schema.String),
      emails: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            status: Schema.optionalKey(Schema.String)
          })
        )
      )
    })
  )
})

export const MailerSendBulkStatus = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.String),
      created_at: Schema.optionalKey(Schema.String)
    })
  )
})

export const MailerSendErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))
  )
})

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 500,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: true,
  cancel: false,
  idempotency: "none"
})

const formatAddress = (address: NormalizedAddress): typeof MailerSendAddress.Type =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<MailerSendAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      new UnsupportedCapability({
        message: "MailerSend does not accept remote attachment URLs",
        provider: "mailersend",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "MailerSend adapter cannot read attachments from local paths; provide bytes instead",
        provider: "mailersend",
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
    disposition:
      attachment.disposition ?? (attachment.contentId === undefined ? "attachment" : "inline"),
    ...(attachment.contentId === undefined ? {} : { id: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<MailerSendPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailerSend adapter supports rendered content only, received ${message.content._tag}`,
        provider: "mailersend",
        capability: "content"
      })
    )
  }

  if (message.cc.length > 10) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailerSend accepts at most 10 CC recipients, got ${message.cc.length}`,
        provider: "mailersend",
        capability: "cc-recipients"
      })
    )
  }
  if (message.bcc.length > 10) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailerSend accepts at most 10 BCC recipients, got ${message.bcc.length}`,
        provider: "mailersend",
        capability: "bcc-recipients"
      })
    )
  }
  if (message.tags.length > 5) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailerSend accepts at most 5 tags, got ${message.tags.length}`,
        provider: "mailersend",
        capability: "tags"
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
      ...(message.replyTo[0] === undefined
        ? {}
        : { reply_to: formatAddress(message.replyTo[0]) }),
      subject: message.subject,
      ...(content.text === undefined ? {} : { text: content.text }),
      ...(content.html === undefined ? {} : { html: content.html }),
      ...(message.headers.length === 0
        ? {}
        : {
            headers: message.headers.map(([name, value]) => ({ name, value }))
          }),
      ...(message.tags.length === 0 ? {} : { tags: [...message.tags] }),
      ...(attachments.length === 0 ? {} : { attachments })
    }))
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

const errorMessage = (body: typeof MailerSendErrorBody.Type): string => {
  const parts: Array<string> = []
  if (body.errors !== undefined) {
    for (const [field, reasons] of Object.entries(body.errors)) {
      const list = Array.isArray(reasons) ? reasons : [reasons]
      parts.push(`${field}: ${list.join(", ")}`)
    }
  }
  if (parts.length > 0) {
    return parts.join("; ")
  }
  return body.message ?? "MailerSend request failed"
}

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<typeof MailerSendErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(MailerSendErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof MailerSendErrorBody.Type
): TransportError => {
  const message = errorMessage(body)
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "mailersend",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
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

const execute = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
  client.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new TransportUnavailable({
          message: "MailerSend request failed before a response was received",
          provider: "mailersend",
          retryable: true,
          cause
        })
    )
  )

const makeSendEmail = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) =>
  Effect.fn("MailerSend.sendEmail")(function* (
    payload: MailerSendPayload
  ): Effect.fn.Return<MailerSendSendResult, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/v1/email`),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(apiKey)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )

    const response = yield* execute(client, request)

    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }

    const headerId = headerValue(response, "x-message-id")
    const body = yield* response.json.pipe(
      Effect.orElseSucceed(() => ({}))
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailerSendSuccess)(
      body
    ).pipe(Effect.orElseSucceed((): typeof MailerSendSuccess.Type => ({})))
    const id = headerId ?? decoded.message_id
    if (id === undefined || id.length === 0) {
      return yield* new MalformedProviderResponse({
        message: "MailerSend success response did not contain x-message-id",
        provider: "mailersend",
        status: response.status,
        cause: body
      })
    }
    return { id: providerMessageId(id) }
  })

const makeSendBulk = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) =>
  Effect.fn("MailerSend.sendBulk")(function* (
    payloads: ReadonlyArray<MailerSendPayload>
  ): Effect.fn.Return<ProviderMessageId, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/v1/bulk-email`),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(apiKey)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payloads)
    )

    const response = yield* execute(client, request)

    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend returned an unreadable bulk response",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailerSendSuccess)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend bulk response did not contain bulk_email_id",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    if (decoded.bulk_email_id === undefined) {
      return yield* new MalformedProviderResponse({
        message: "MailerSend bulk response did not contain bulk_email_id",
        provider: "mailersend",
        status: response.status,
        cause: body
      })
    }
    return providerMessageId(decoded.bulk_email_id)
  })

const getRequest = (
  url: string,
  apiKey: Redacted.Redacted<string>
): HttpClientRequest.HttpClientRequest =>
  pipe(
    HttpClientRequest.get(url),
    HttpClientRequest.setHeader(
      "Authorization",
      `Bearer ${Redacted.value(apiKey)}`
    ),
    HttpClientRequest.setHeader("Accept", "application/json")
  )

const parseDateTime = (value: string | undefined): DateTime.Utc | undefined => {
  if (value === undefined) {
    return undefined
  }
  const millis = Date.parse(value)
  return Number.isNaN(millis)
    ? undefined
    : DateTime.makeUnsafe(new Date(millis))
}

const makeRetrieveBulk = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string
) =>
  Effect.fn("MailerSend.retrieveBulk")(function* (
    id: ProviderMessageId
  ): Effect.fn.Return<MailerSendStatus, TransportError> {
    const response = yield* execute(
      client,
      getRequest(
        `${baseUrl}/v1/bulk-email/${encodeURIComponent(id)}`,
        apiKey
      )
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend returned an unreadable bulk status response",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailerSendBulkStatus)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend bulk status response had an unexpected shape",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    const data = decoded.data ?? {}
    const at = parseDateTime(data.created_at)
    return {
      id: providerMessageId(data.id ?? id),
      state: toBulkState(data.state),
      ...(at === undefined ? {} : { at }),
      provider: body
    }
  })

const makeRetrieve = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  baseUrl: string,
  retrieveBulk: MailerSendClient["retrieveBulk"]
) =>
  Effect.fn("MailerSend.retrieve")(function* (
    id: ProviderMessageId
  ): Effect.fn.Return<MailerSendStatus, TransportError> {
    const response = yield* execute(
      client,
      getRequest(`${baseUrl}/v1/messages/${encodeURIComponent(id)}`, apiKey)
    )

    if (response.status === 404) {
      return yield* retrieveBulk(id)
    }
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(response, body)
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend returned an unreadable message status response",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailerSendMessageStatus)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailerSend message status response had an unexpected shape",
            provider: "mailersend",
            status: response.status,
            cause
          })
      )
    )
    const data = decoded.data ?? {}
    const at = parseDateTime(data.created_at)
    return {
      id: providerMessageId(data.id ?? id),
      state: toState(data.emails?.[0]?.status),
      ...(at === undefined ? {} : { at }),
      provider: body
    }
  })

const toState = (status: string | undefined): MailerSendState => {
  switch (status) {
    case "queued":
    case "processed":
      return "queued"
    case "sent":
    case "delivered":
    case "opened":
    case "clicked":
      return status
    case "soft_bounced":
    case "hard_bounced":
      return "bounced"
    case "spam_complaint":
      return "complained"
    case "rejected":
      return "failed"
    default:
      return "unknown"
  }
}

const toBulkState = (state: string | undefined): MailerSendState => {
  switch (state) {
    case "completed":
      return "sent"
    case "processing":
      return "queued"
    case "failed":
      return "failed"
    default:
      return "unknown"
  }
}

const receiptFor = (
  envelope: PreparedEnvelope,
  destinationIdValue: DestinationId,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "mailersend",
  destinationId: destinationIdValue,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

const makeTransport = (
  options: MailerSendOptions,
  sendEmail: MailerSendClient["sendEmail"],
  sendBulk: MailerSendClient["sendBulk"],
  retrieve: MailerSendClient["retrieve"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "mailersend",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("MailerSend.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload)
    return receiptFor(envelope, resolvedDestinationId, result.id, acceptedAt)
  })

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "MailerSend.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const payloads: Array<MailerSendPayload> = []
    const slots: Array<number> = []

    for (const [index, envelope] of envelopes.entries()) {
      const result = yield* Effect.result(payloadFor(envelope.message))
      if (result._tag === "Failure") {
        outcomes[index] = certaintyOf(result.failure) === "unknown"
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
    const result = yield* Effect.result(sendBulk(payloads))
    if (result._tag === "Failure") {
      for (const index of slots) {
        outcomes[index] = certaintyOf(result.failure) === "unknown"
          ? { _tag: "uncertain", index, error: result.failure }
          : { _tag: "rejected", index, error: result.failure }
      }
      return outcomes
    }

    for (const index of slots) {
      outcomes[index] = {
        _tag: "accepted",
        index,
        receipt: receiptFor(
          envelopes[index]!,
          resolvedDestinationId,
          result.success,
          acceptedAt
        )
      }
    }
    return outcomes
  })

  const retrieveReceipt: NonNullable<Transport["retrieve"]> = (receipt) => {
    const id = receipt.providerMessageId
    if (id === undefined) {
      return Effect.fail(
        new UnsupportedCapability({
          message: "MailerSend retrieval requires a provider message id",
          provider: "mailersend",
          capability: "retrieve"
        })
      )
    }
    return Effect.map(retrieve(id), (status) => ({
      providerMessageId: status.id,
      provider: "mailersend",
      state: status.state,
      ...(status.at === undefined ? {} : { at: status.at })
    }))
  }

  return {
    destination,
    capabilities: capabilities as NativeBatchTransport["capabilities"],
    send,
    sendBatch,
    retrieve: retrieveReceipt
  }
}

export const makeClient = (
  options: MailerSendOptions
): Effect.Effect<MailerSendClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? "https://api.mailersend.com"
    const sendEmail = makeSendEmail(httpClient, options.apiKey, baseUrl)
    const sendBulk = makeSendBulk(httpClient, options.apiKey, baseUrl)
    const retrieveBulk = makeRetrieveBulk(
      httpClient,
      options.apiKey,
      baseUrl
    )
    const retrieve = makeRetrieve(
      httpClient,
      options.apiKey,
      baseUrl,
      retrieveBulk
    )
    return {
      transport: makeTransport(options, sendEmail, sendBulk, retrieve),
      sendEmail,
      sendBulk,
      retrieve,
      retrieveBulk
    }
  })

export const make = (
  options: MailerSendOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailerSendOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailerSendOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailerSendOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailerSendOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("MAILERSEND_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailersend", account })


