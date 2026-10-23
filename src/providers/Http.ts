import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted
} from "effect"
import { Base64 } from "effect/encoding"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import type { DeliveryId, Destination, ProviderMessageId, RouteName } from "../Ids"
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
import type { Attachment, PreparedMessage } from "../Message"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export type HttpAuth =
  | { readonly type: "bearer"; readonly token: Redacted.Redacted<string> }
  | {
      readonly type: "basic"
      readonly username: string
      readonly password: Redacted.Redacted<string>
    }
  | { readonly type: "header"; readonly name: string; readonly value: string }

export interface HttpBodyContext {
  readonly deliveryId: DeliveryId
  readonly route: RouteName
  readonly providerIdempotencyKey?: string
}

export type HttpFailureClass =
  | "authentication"
  | "rate-limit"
  | "rejected"
  | "unavailable"
  | "uncertain"

export interface HttpClassification {
  readonly class?: HttpFailureClass
  readonly message?: string
  readonly retryable?: boolean
  readonly retryAfterMillis?: number
}

export interface HttpOptions {
  readonly endpoint: string
  readonly method?:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
  readonly auth?: HttpAuth
  readonly headers?:
    | Readonly<Record<string, string>>
    | ((message: PreparedMessage, context: HttpBodyContext) => Readonly<Record<string, string>>)
  readonly body?: (message: PreparedMessage, context: HttpBodyContext) => unknown
  readonly extractId?: (
    body: unknown,
    message: PreparedMessage
  ) => string | null | undefined
  readonly classify?: (
    status: number,
    body: unknown
  ) => HttpClassification | null
  readonly capabilities?: Partial<TransportCapabilities>
  readonly name?: string
  readonly account?: string
}

export interface HttpSendResult {
  readonly id: ProviderMessageId
  readonly status: number
}

export interface HttpClientService {
  readonly transport: Transport
  readonly sendEmail: (
    message: PreparedMessage,
    context: HttpBodyContext
  ) => Effect.Effect<HttpSendResult, TransportError>
}

export class Client extends Context.Service<Client, HttpClientService>()(
  "@effect-email/providers/Http/Client"
) {}

const DEFAULT_NAME = "http"

const ID_KEYS = ["id", "messageId", "message_id", "MessageID"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pickId = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null
  }
  for (const key of ID_KEYS) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
    if (typeof candidate === "number") {
      return String(candidate)
    }
  }
  return null
}

const defaultExtractId = (body: unknown): string | null => {
  if (typeof body === "string") {
    return body.trim() || null
  }
  const direct = pickId(body)
  if (direct !== null) {
    return direct
  }
  return isRecord(body) ? pickId(body.data) : null
}

const formatAddress = (address: PreparedMessage["from"]) =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment,
  provider: string
): Effect.Effect<Record<string, unknown>, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "the generic HTTP body encoder requires attachment bytes; provide content or a custom body",
        provider,
        capability: "attachments"
      })
    )
  }
  return Effect.succeed({
    filename: attachment.filename,
    content:
      attachment.source.encoding === "base64"
        ? new TextDecoder().decode(attachment.source.content)
        : Base64.encode(attachment.source.content),
    encoding: "base64",
    ...(attachment.contentType === undefined
      ? {}
      : { contentType: attachment.contentType }),
    ...(attachment.disposition === undefined
      ? {}
      : { disposition: attachment.disposition }),
    ...(attachment.contentId === undefined
      ? {}
      : { contentId: attachment.contentId })
  })
}

export const defaultBody = (
  message: PreparedMessage,
  provider = DEFAULT_NAME
): Effect.Effect<Record<string, unknown>, UnsupportedCapability> =>
  Effect.forEach(message.attachments, (attachment) =>
    attachmentFor(attachment, provider)
  ).pipe(
    Effect.map((attachments) => ({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      cc: message.cc.map(formatAddress),
      bcc: message.bcc.map(formatAddress),
      replyTo: message.replyTo.map(formatAddress),
      subject: message.subject,
      content: message.content,
      headers: Object.fromEntries(message.headers),
      tags: [...message.tags],
      ...(attachments.length === 0 ? {} : { attachments })
    }))
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

const readResponseText = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string> => response.text.pipe(Effect.orElseSucceed(() => ""))

const parseBody = (text: string): unknown => {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

const errorMessage = (body: unknown, status: number): string => {
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim()
  }
  if (isRecord(body)) {
    const direct = body.message
    if (typeof direct === "string") {
      return direct
    }
    if (isRecord(body.error) && typeof body.error.message === "string") {
      return body.error.message
    }
    if (typeof body.error === "string") {
      return body.error
    }
    if (typeof body.detail === "string") {
      return body.detail
    }
  }
  return `HTTP endpoint responded with status ${status}`
}

const defaultClass = (status: number): HttpFailureClass => {
  if (status === 401 || status === 403) {
    return "authentication"
  }
  if (status === 429) {
    return "rate-limit"
  }
  if (status >= 500) {
    return "unavailable"
  }
  return "rejected"
}

const failureFor = (
  provider: string,
  response: HttpClientResponse.HttpClientResponse,
  body: unknown,
  classification: HttpClassification | null,
  retryAfterMillis: number | undefined
): TransportError => {
  const kind = classification?.class ?? defaultClass(response.status)
  const effectiveRetryAfter =
    classification?.retryAfterMillis ?? retryAfterMillis
  const common = {
    message: classification?.message ?? errorMessage(body, response.status),
    provider,
    status: response.status,
    ...(effectiveRetryAfter === undefined
      ? {}
      : { retryAfterMillis: effectiveRetryAfter }),
    ...(classification?.retryable === undefined
      ? {}
      : { retryable: classification.retryable })
  }
  switch (kind) {
    case "authentication":
      return new AuthenticationFailed(common)
    case "rate-limit":
      return new RateLimited({ ...common, retryable: classification?.retryable ?? true })
    case "unavailable":
      return new TransportUnavailable({
        ...common,
        retryable: classification?.retryable ?? true
      })
    case "uncertain":
      return new DeliveryUncertain(common)
    case "rejected":
      return new ProviderRejected(common)
  }
}

const encodeBody = (
  message: PreparedMessage,
  options: HttpOptions,
  context: HttpBodyContext
): Effect.Effect<
  { readonly kind: "json"; readonly value: unknown } | { readonly kind: "text"; readonly value: string },
  TransportError
> => {
  if (options.body !== undefined) {
    return Effect.sync(() => {
      const value = options.body!(message, context)
      return typeof value === "string"
        ? { kind: "text" as const, value }
        : { kind: "json" as const, value }
    })
  }
  return Effect.map(defaultBody(message, options.name ?? DEFAULT_NAME), (value) => ({
    kind: "json" as const,
    value
  }))
}

const authHeaders = (
  auth: HttpAuth | undefined
): Readonly<Record<string, string>> => {
  if (auth === undefined) {
    return {}
  }
  switch (auth.type) {
    case "bearer":
      return { authorization: `Bearer ${Redacted.value(auth.token)}` }
    case "basic":
      return {
        authorization: `Basic ${Base64.encode(
          new TextEncoder().encode(
            `${auth.username}:${Redacted.value(auth.password)}`
          )
        )}`
      }
    case "header":
      return { [auth.name]: auth.value }
  }
}

const receiptFor = (
  envelope: PreparedEnvelope,
  provider: string,
  resolvedDestinationId: ReturnType<typeof destinationId>,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc,
  status: number
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider,
  destinationId: resolvedDestinationId,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route,
  metadata: { httpStatus: status }
})

const makeTransport = (
  options: HttpOptions,
  sendEmail: HttpClientService["sendEmail"]
): Transport => {
  const provider = options.name ?? DEFAULT_NAME
  const destination = makeDestination({
    provider,
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Http.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(envelope.message, {
      deliveryId: envelope.deliveryId,
      route: envelope.route,
      ...(envelope.providerIdempotencyKey === undefined
        ? {}
        : { providerIdempotencyKey: envelope.providerIdempotencyKey })
    })
    return receiptFor(
      envelope,
      provider,
      resolvedDestinationId,
      result.id,
      acceptedAt,
      result.status
    )
  })

  return {
    destination,
    capabilities: makeCapabilities({
      attachments: true,
      tags: true,
      providerTemplates: true,
      ...options.capabilities
    }),
    send
  }
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: HttpOptions
) => {
  const provider = options.name ?? DEFAULT_NAME
  return Effect.fn("Http.sendEmail")(function* (
    message: PreparedMessage,
    context: HttpBodyContext
  ): Effect.fn.Return<HttpSendResult, TransportError> {
    const encoded = yield* encodeBody(message, options, context)
    const supplied =
      typeof options.headers === "function"
        ? options.headers(message, context)
        : (options.headers ?? {})
    const headers = { ...authHeaders(options.auth), ...supplied }
    let request = HttpClientRequest.make(options.method ?? "POST")(
      options.endpoint
    )
    request = HttpClientRequest.setHeader(
      request,
      "Accept",
      "application/json"
    )
    for (const [name, value] of Object.entries(headers)) {
      request = HttpClientRequest.setHeader(request, name, value)
    }
    const suppliedContentType = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type"
    )?.[1]
    request =
      encoded.kind === "text"
        ? HttpClientRequest.bodyText(
            request,
            encoded.value,
            suppliedContentType ?? "text/plain"
          )
        : HttpClientRequest.bodyJsonUnsafe(request, encoded.value)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "HTTP endpoint request failed before a response was received; outcome is unknown",
            provider,
            cause
          })
      )
    )
    const text = yield* readResponseText(response)
    const body = parseBody(text)
    if (response.status < 200 || response.status >= 300) {
      const classification =
        options.classify?.(response.status, body) ?? null
      return yield* failureFor(
        provider,
        response,
        body,
        classification,
        parseRetryAfter(headerValue(response, "retry-after"))
      )
    }
    const extracted = options.extractId
      ? options.extractId(body, message)
      : defaultExtractId(body)
    return {
      id: providerMessageId(extracted ?? `gateway_${context.deliveryId}`),
      status: response.status
    }
  })
}

export const makeClient = (
  options: HttpOptions
): Effect.Effect<HttpClientService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: HttpOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: HttpOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: HttpOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: HttpOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const destinationFor = (name = DEFAULT_NAME, account = "default"): Destination =>
  makeDestination({ provider: name, account })

export { UnsupportedCapability }
