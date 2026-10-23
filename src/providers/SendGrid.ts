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
  certaintyOf,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  DeliveryUncertain,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type {
  Attachment,
  NormalizedAddress,
  PreparedMessage
} from "../Message"
import type {
  MessageOutcome,
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type {
  NativeBatchTransport,
  TransportCapabilities
} from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface SendGridOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
  readonly onBehalfOf?: string
  readonly ipPoolName?: string
  readonly sandbox?: boolean
}

export interface SendGridClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: SendGridRequest
  ) => Effect.Effect<SendGridSendResult, TransportError>
}

export class Client extends Context.Service<Client, SendGridClient>()(
  "@effect-email/providers/SendGrid/Client"
) {}

export interface SendGridSendResult {
  readonly id: ProviderMessageId
  readonly requestId?: string
}

export interface SendGridAddress {
  readonly email: string
  readonly name?: string
}

export interface SendGridPersonalization {
  readonly to: ReadonlyArray<SendGridAddress>
  readonly cc?: ReadonlyArray<SendGridAddress>
  readonly bcc?: ReadonlyArray<SendGridAddress>
  readonly subject: string
}

export interface SendGridContent {
  readonly type: string
  readonly value: string
}

export interface SendGridAttachment {
  readonly filename: string
  readonly content: string
  readonly type: string
  readonly disposition: "attachment" | "inline"
  readonly content_id?: string
}

export interface SendGridRequest {
  readonly from: SendGridAddress
  readonly personalizations: ReadonlyArray<SendGridPersonalization>
  readonly subject?: string
  readonly content?: ReadonlyArray<SendGridContent>
  readonly reply_to?: SendGridAddress
  readonly reply_to_list?: ReadonlyArray<SendGridAddress>
  readonly headers?: Readonly<Record<string, string>>
  readonly categories?: ReadonlyArray<string>
  readonly attachments?: ReadonlyArray<SendGridAttachment>
  readonly ip_pool_name?: string
  readonly mail_settings?: {
    readonly sandbox_mode: { readonly enable: boolean }
  }
}

export const SendGridError = Schema.Struct({
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        field: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String)
      })
    )
  )
})

const MAX_PERSONALIZATIONS = 1000
const MAX_RECIPIENTS = 1000

export const capabilities: TransportCapabilities & {
  readonly nativeBatch: true
} = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: MAX_PERSONALIZATIONS,
  maxRecipientsPerMessage: MAX_RECIPIENTS,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
}) as TransportCapabilities & { readonly nativeBatch: true }

const formatAddress = (address: NormalizedAddress): SendGridAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<SendGridAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      UnsupportedCapability.new({
        message:
          "SendGrid adapter requires attachment bytes; remote and path sources are not supported",
        provider: "sendgrid",
        capability:
          attachment.source._tag === "url"
            ? "remote-attachments"
            : "attachments"
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
    type: attachment.contentType ?? "application/octet-stream",
    disposition:
      attachment.contentId === undefined
        ? (attachment.disposition ?? "attachment")
        : "inline",
    ...(attachment.contentId === undefined
      ? {}
      : { content_id: attachment.contentId })
  })
}

interface EnvelopePayload {
  readonly base: Omit<SendGridRequest, "personalizations">
  readonly personalization: SendGridPersonalization
}

const envelopeFor = (
  message: PreparedMessage,
  options: SendGridOptions
): Effect.Effect<EnvelopePayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: `SendGrid adapter supports rendered content only, received ${message.content._tag}`,
        provider: "sendgrid",
        capability: "content"
      })
    )
  }

  const content = message.content
  const rendered: SendGridContent[] = []
  if (content.text !== undefined) {
    rendered.push({ type: "text/plain", value: content.text })
  }
  if (content.html !== undefined) {
    rendered.push({ type: "text/html", value: content.html })
  }

  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => ({
      base: {
        from: formatAddress(message.from),
        ...(rendered.length === 0 ? {} : { content: rendered }),
        ...(message.replyTo.length === 0
          ? {}
          : message.replyTo.length === 1
            ? { reply_to: formatAddress(message.replyTo[0]!) }
            : { reply_to_list: message.replyTo.map(formatAddress) }),
        ...(message.headers.length === 0
          ? {}
          : { headers: Object.fromEntries(message.headers) }),
        ...(message.tags.length === 0
          ? {}
          : { categories: [...new Set(message.tags)] }),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(options.ipPoolName === undefined
          ? {}
          : { ip_pool_name: options.ipPoolName }),
        ...(options.sandbox === true
          ? { mail_settings: { sandbox_mode: { enable: true } } }
          : {})
      },
      personalization: {
        to: message.to.map(formatAddress),
        ...(message.cc.length === 0
          ? {}
          : { cc: message.cc.map(formatAddress) }),
        ...(message.bcc.length === 0
          ? {}
          : { bcc: message.bcc.map(formatAddress) }),
        subject: message.subject
      }
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

const classifyFailure = (
  status: number,
  message: string,
  response: HttpClientResponse.HttpClientResponse
): TransportError => {
  const requestId = headerValue(response, "x-request-id")
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "sendgrid",
    status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
  if (status === 401 || status === 403) {
    return AuthenticationFailed.new(common)
  }
  if (status === 429) {
    return RateLimited.new({ ...common, retryable: true })
  }
  if (status >= 500) {
    return TransportUnavailable.new({ ...common, retryable: true })
  }
  return ProviderRejected.new(common)
}

const errorMessage = (body: unknown): string | undefined => {
  if (body === null || typeof body !== "object") {
    return undefined
  }
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors)) {
    return undefined
  }
  const messages: string[] = []
  for (const entry of errors) {
    if (entry === null || typeof entry !== "object") {
      continue
    }
    const { field, message } = entry as {
      readonly field?: unknown
      readonly message?: unknown
    }
    if (typeof message !== "string") {
      continue
    }
    messages.push(
      typeof field === "string" && field.length > 0
        ? `${field}: ${message}`
        : message
    )
  }
  return messages.length === 0 ? undefined : messages.join("; ")
}

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<unknown> =>
  response.json.pipe(Effect.orElseSucceed(() => undefined))

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: SendGridOptions,
  baseUrl: string
) =>
  Effect.fn("SendGrid.sendEmail")(function* (
    payload: SendGridRequest
  ): Effect.fn.Return<SendGridSendResult, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/v3/mail/send`),
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(options.apiKey)}`
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      options.onBehalfOf === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("on-behalf-of", options.onBehalfOf),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          DeliveryUncertain.new({
            message: "SendGrid request failed before a response was received; outcome is unknown",
            provider: "sendgrid",
            cause
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* readErrorBody(response)
      return yield* classifyFailure(
        response.status,
        errorMessage(body) ?? `SendGrid rejected the request (${response.status})`,
        response
      )
    }

    const id = headerValue(response, "x-message-id")
    if (id === undefined || id.length === 0) {
      return yield* MalformedProviderResponse.new({
        message: "SendGrid response did not include an x-message-id header",
        provider: "sendgrid",
        status: response.status
      })
    }

    const requestId = headerValue(response, "x-request-id")
    return {
      id: providerMessageId(id),
      ...(requestId === undefined ? {} : { requestId })
    }
  })

const makeTransport = (
  options: SendGridOptions,
  sendEmail: SendGridClient["sendEmail"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "sendgrid",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const deliver = (
    entries: ReadonlyArray<{
      readonly index: number
      readonly envelope: PreparedEnvelope
      readonly payload: EnvelopePayload
    }>
  ): Effect.Effect<ReadonlyArray<MessageOutcome>> => {
    const request: SendGridRequest = {
      ...entries[0]!.payload.base,
      personalizations: entries.map((entry) => entry.payload.personalization)
    }
    return Effect.gen(function* () {
      const result = yield* Effect.result(sendEmail(request))
      if (result._tag === "Failure") {
        return entries.map(
          (entry): MessageOutcome =>
            certaintyOf(result.failure) === "unknown"
              ? {
                  _tag: "uncertain",
                  index: entry.index,
                  error: result.failure
                }
              : {
                  _tag: "rejected",
                  index: entry.index,
                  error: result.failure
                }
        )
      }
      const acceptedAt = yield* DateTime.now
      return entries.map(
        (entry): MessageOutcome => ({
          _tag: "accepted",
          index: entry.index,
          receipt: {
            deliveryId: entry.envelope.deliveryId,
            provider: "sendgrid",
            destinationId: resolvedDestinationId,
            providerMessageId: result.success.id,
            acceptedAt,
            route: entry.envelope.route,
            ...(result.success.requestId === undefined
              ? {}
              : { requestId: result.success.requestId })
          }
        })
      )
    })
  }

  const chunk = (
    entries: ReadonlyArray<{
      readonly index: number
      readonly envelope: PreparedEnvelope
      readonly payload: EnvelopePayload
    }>
  ) => {
    const chunks: Array<typeof entries> = []
    let current: Array<(typeof entries)[number]> = []
    let recipients = 0
    let seen = new Set<string>()
    for (const entry of entries) {
      const addresses = [
        ...entry.envelope.message.to,
        ...entry.envelope.message.cc,
        ...entry.envelope.message.bcc
      ].map((address) => address.address.toLowerCase())
      const duplicate = addresses.some((address) => seen.has(address))
      if (
        current.length > 0 &&
        (duplicate ||
          current.length >= MAX_PERSONALIZATIONS ||
          recipients + addresses.length > MAX_RECIPIENTS)
      ) {
        chunks.push(current)
        current = []
        recipients = 0
        seen = new Set()
      }
      current.push(entry)
      recipients += addresses.length
      for (const address of addresses) {
        seen.add(address)
      }
    }
    if (current.length > 0) {
      chunks.push(current)
    }
    return chunks
  }

  const send = Effect.fn("SendGrid.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* envelopeFor(envelope.message, options)
    const outcomes = yield* deliver([
      { index: 0, envelope, payload }
    ])
    const outcome = outcomes[0]!
    if (outcome._tag === "accepted") {
      return outcome.receipt
    }
    return yield* (outcome.error as TransportError)
  })

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "SendGrid.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const prepared = yield* Effect.forEach(envelopes, (envelope) =>
      Effect.result(envelopeFor(envelope.message, options))
    )
    const outcomes: Array<MessageOutcome> = []
    const groups = new Map<
      string,
      Array<{
        index: number
        envelope: PreparedEnvelope
        payload: EnvelopePayload
      }>
    >()

    for (const [index, result] of prepared.entries()) {
      if (result._tag === "Failure") {
        outcomes.push({
          _tag: "invalid",
          index,
          error: result.failure
        })
        continue
      }
      const key = JSON.stringify(result.success.base)
      const group = groups.get(key)
      const entry = {
        index,
        envelope: envelopes[index]!,
        payload: result.success
      }
      if (group === undefined) {
        groups.set(key, [entry])
      } else {
        group.push(entry)
      }
    }

    for (const group of groups.values()) {
      for (const groupChunk of chunk(group)) {
        const delivered = yield* deliver(groupChunk)
        outcomes.push(...delivered)
      }
    }

    return outcomes.sort((left, right) => left.index - right.index)
  })

  return {
    destination,
    capabilities,
    send,
    sendBatch
  }
}

export const makeClient = (
  options: SendGridOptions
): Effect.Effect<SendGridClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? "https://api.sendgrid.com"
    const sendEmail = makeSendEmail(httpClient, options, baseUrl)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: SendGridOptions
): Effect.Effect<NativeBatchTransport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: SendGridOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: SendGridOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: SendGridOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<SendGridOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("SENDGRID_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "sendgrid", account })


