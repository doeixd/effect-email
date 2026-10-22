import {
  DateTime,
  Effect,
  Layer,
  Option,
  Schema
} from "effect"
import { Base64 } from "effect/encoding"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import type { Destination } from "../Ids"
import { destinationId, makeDestination, providerMessageId } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { PreparedMessage } from "../Message"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import type {
  DeliveryStatus,
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"

export interface AzureCommunicationOptions {
  readonly connectionString?: string
  readonly endpoint?: string
  readonly accessKey?: string
  readonly apiVersion?: string
  readonly userEngagementTrackingDisabled?: boolean
  readonly account?: string
  readonly now?: Date
}

const DEFAULT_API_VERSION = "2025-09-01"
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: true,
  cancel: false,
  idempotency: "request"
})

interface Credentials {
  readonly endpoint: string
  readonly accessKey: string
}

const parseConnectionString = (
  value: string
): Credentials | undefined => {
  let endpoint = ""
  let accessKey = ""
  for (const part of value.split(";")) {
    const segment = part.trim()
    if (segment.length === 0) continue
    const at = segment.indexOf("=")
    if (at < 1) return undefined
    const name = segment.slice(0, at).trim().toLowerCase()
    const item = segment.slice(at + 1).trim()
    if (name === "endpoint") endpoint = item
    if (name === "accesskey") accessKey = item
  }
  if (endpoint.length === 0 || accessKey.length === 0) {
    return undefined
  }
  return { endpoint: endpoint.replace(/\/+$/, ""), accessKey }
}

const resolveCredentials = (
  options: AzureCommunicationOptions
): Effect.Effect<Credentials, MalformedProviderResponse> => {
  if (options.connectionString !== undefined) {
    const parsed = parseConnectionString(options.connectionString)
    return parsed === undefined
      ? Effect.fail(
          new MalformedProviderResponse({
            message: "invalid Azure Communication connection string",
            provider: "azure-communication"
          })
        )
      : Effect.succeed(parsed)
  }
  if (options.endpoint !== undefined && options.accessKey !== undefined) {
    return Effect.succeed({
      endpoint: options.endpoint.replace(/\/+$/, ""),
      accessKey: options.accessKey
    })
  }
  return Effect.fail(
    new MalformedProviderResponse({
      message:
        "Azure Communication requires connectionString or endpoint + accessKey",
      provider: "azure-communication"
    })
  )
}

const address = (value: PreparedMessage["from"]) => ({
  address: value.address,
  ...(value.name === undefined ? {} : { displayName: value.name })
})

const operationId = (
  key: string | undefined
): Effect.Effect<string | undefined> => {
  if (key === undefined) return Effect.succeed(undefined)
  if (UUID.test(key)) return Effect.succeed(key)
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

const attachmentFor = (attachment: PreparedMessage["attachments"][number]) => {
  switch (attachment.source._tag) {
    case "path":
      return Effect.fail(
        new UnsupportedCapability({
          message:
            "Azure Communication cannot read attachments from local paths",
          provider: "azure-communication",
          capability: "attachments"
        })
      )
    case "url":
      return Effect.fail(
        new UnsupportedCapability({
          message:
            "Azure Communication does not fetch remote attachment URLs",
          provider: "azure-communication",
          capability: "remote-attachments"
        })
      )
    case "content":
      return Effect.succeed({
        name: attachment.filename,
        contentType:
          attachment.contentType ?? "application/octet-stream",
        contentInBase64:
          attachment.source.encoding === "base64"
            ? new TextDecoder().decode(attachment.source.content)
            : Base64.encode(attachment.source.content),
        ...(attachment.contentId === undefined
          ? {}
          : { contentId: attachment.contentId })
      })
  }
}

const payloadFor = (
  message: PreparedMessage,
  options: AzureCommunicationOptions
): Effect.Effect<unknown, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Azure Communication requires rendered text or HTML content",
        provider: "azure-communication",
        capability: "content"
      })
    )
  }
  const content = message.content
  const headers: Record<string, string> = Object.fromEntries(
    message.headers
  )
  for (const tag of message.tags) {
    headers[`X-Tag-${tag}`] = ""
  }
  return Effect.map(
    Effect.forEach(message.attachments, attachmentFor),
    (attachments) => ({
      senderAddress: message.from.address,
      recipients: {
        to: message.to.map(address),
        ...(message.cc.length === 0
          ? {}
          : { cc: message.cc.map(address) }),
        ...(message.bcc.length === 0
          ? {}
          : { bcc: message.bcc.map(address) })
      },
      replyTo:
        message.replyTo.length === 0
          ? undefined
          : message.replyTo.map(address),
      content: {
        subject: message.subject,
        ...(content.text === undefined
          ? {}
          : { plainText: content.text }),
        ...(content.html === undefined
          ? {}
          : { html: content.html })
      },
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(options.userEngagementTrackingDisabled === undefined
        ? {}
        : {
            userEngagementTrackingDisabled:
              options.userEngagementTrackingDisabled
          })
    })
  )
}

const sha256Base64 = (
  value: string
): Effect.Effect<string, TransportError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value)
      )
      return Base64.encode(new Uint8Array(digest))
    },
    catch: (cause) =>
      new TransportUnavailable({
        message: "Azure Communication hashing failed",
        provider: "azure-communication",
        cause
      })
  })

const hmacBase64 = (
  key: Uint8Array,
  value: string
): Effect.Effect<string, TransportError> =>
  Effect.tryPromise({
    try: async () => {
      const cryptoKey = await globalThis.crypto.subtle.importKey(
        "raw",
        key.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const signature = await globalThis.crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(value)
      )
      return Base64.encode(new Uint8Array(signature))
    },
    catch: (cause) =>
      new TransportUnavailable({
        message: "Azure Communication signing failed",
        provider: "azure-communication",
        cause
      })
  })

const signedHeaders = (
  credentials: Credentials,
  options: AzureCommunicationOptions,
  method: string,
  url: string,
  body: string
): Effect.Effect<Readonly<Record<string, string>>, TransportError> =>
  Effect.gen(function* () {
    const parsed = new URL(url)
    const date = (options.now ?? new Date()).toUTCString()
    const contentHash = yield* sha256Base64(body)
    const stringToSign = `${method}\n${parsed.pathname}${parsed.search}\n${date};${parsed.host};${contentHash}`
    const decoded = new Uint8Array(
      [...atob(credentials.accessKey)].map((char) => char.charCodeAt(0))
    )
    const signature = yield* hmacBase64(decoded, stringToSign)
    return {
      "x-ms-date": date,
      "x-ms-content-sha256": contentHash,
      authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
    }
  })

const headerValue = (
  response: HttpClientResponse.HttpClientResponse,
  name: string
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, name))

const errorBody = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String)
    })
  )
})

const failure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof errorBody.Type
): TransportError => {
  const message =
    body.error?.message ??
    `Azure Communication request failed with status ${response.status}`
  const common = {
    message,
    provider: "azure-communication",
    status: response.status,
    ...(headerValue(response, "x-ms-request-id") === undefined
      ? {}
      : {
          requestId: headerValue(response, "x-ms-request-id")
        })
  }
  const code = body.error?.code ?? ""
  if (
    response.status === 401 ||
    response.status === 403 ||
    /Unauthorized|Unauthenticated|Forbidden|AuthenticationFailed/i.test(
      code
    )
  ) {
    return new AuthenticationFailed(common)
  }
  if (
    response.status === 429 ||
    /TooManyRequests|Throttl|QuotaExceeded/i.test(code)
  ) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

const readError = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<typeof errorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(errorBody)(value).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const operationIdFrom = (location: string | undefined): string | undefined => {
  if (location === undefined) return undefined
  const match = /\/emails\/operations\/([^/?#]+)/.exec(location)
  return match?.[1] === undefined
    ? undefined
    : decodeURIComponent(match[1])
}

const stateOf = (status: string | undefined): DeliveryStatus["state"] => {
  switch (status) {
    case "NotStarted":
    case "Running":
      return "queued"
    case "Succeeded":
      return "sent"
    case "Failed":
      return "failed"
    default:
      return "unknown"
  }
}

export const make = (
  options: AzureCommunicationOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const credentials = yield* resolveCredentials(options).pipe(
      Effect.orDie
    )
    const client = yield* HttpClient.HttpClient
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION
    const destination: Destination = makeDestination({
      provider: "azure-communication",
      account: options.account ?? credentials.endpoint
    })
    const resolvedDestinationId = destinationId(destination)

    const send = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.gen(function* () {
        const payload = yield* payloadFor(envelope.message, options)
        const body = JSON.stringify(payload)
        const id = yield* operationId(
          envelope.providerIdempotencyKey
        )
        const url = `${credentials.endpoint}/emails:send?api-version=${apiVersion}`
        const headers = yield* signedHeaders(
          credentials,
          options,
          "POST",
          url,
          body
        )
        let request = HttpClientRequest.post(url)
        for (const [name, value] of Object.entries(headers)) {
          request = HttpClientRequest.setHeader(request, name, value)
        }
        if (id !== undefined) {
          request = HttpClientRequest.setHeader(
            request,
            "operation-id",
            id
          )
        }
        request = HttpClientRequest.bodyText(
          request,
          body,
          "application/json"
        )
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new TransportUnavailable({
                message:
                  "Azure Communication request failed before a response",
                provider: "azure-communication",
                retryable: true,
                cause
              })
          )
        )
        if (response.status < 200 || response.status >= 300) {
          const error = yield* readError(response)
          return yield* failure(response, error)
        }
        const parsed = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new MalformedProviderResponse({
                message:
                  "Azure Communication returned an unreadable response",
                provider: "azure-communication",
                status: response.status,
                cause
              })
          )
        )
        const location = headerValue(response, "operation-location")
        const responseId =
          (parsed as { id?: string }).id ??
          operationIdFrom(location) ??
          id
        if (responseId === undefined) {
          return yield* new MalformedProviderResponse({
            message:
              "Azure Communication response carried no operation id",
            provider: "azure-communication",
            status: response.status,
            cause: parsed
          })
        }
        const acceptedAt = yield* DateTime.now
        return {
          deliveryId: envelope.deliveryId,
          provider: "azure-communication",
          destinationId: resolvedDestinationId,
          providerMessageId: providerMessageId(responseId),
          acceptedAt,
          route: envelope.route,
          ...(headerValue(response, "x-ms-request-id") === undefined
            ? {}
            : {
                requestId: headerValue(
                  response,
                  "x-ms-request-id"
                )
              })
        }
      })

    const retrieve: NonNullable<Transport["retrieve"]> = (receipt) => {
      if (receipt.providerMessageId === undefined) {
        return Effect.fail(
          new UnsupportedCapability({
            message:
              "Azure Communication retrieval requires an operation id",
            provider: "azure-communication",
            capability: "retrieve"
          })
        )
      }
      const id = receipt.providerMessageId
      const url = `${credentials.endpoint}/emails/operations/${encodeURIComponent(
        id
      )}?api-version=${apiVersion}`
      return Effect.gen(function* () {
        const headers = yield* signedHeaders(
          credentials,
          options,
          "GET",
          url,
          ""
        )
        let request = HttpClientRequest.get(url)
        for (const [name, value] of Object.entries(headers)) {
          request = HttpClientRequest.setHeader(request, name, value)
        }
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new TransportUnavailable({
                message:
                  "Azure Communication status request failed",
                provider: "azure-communication",
                retryable: true,
                cause
              })
          )
        )
        if (response.status < 200 || response.status >= 300) {
          const error = yield* readError(response)
          return yield* failure(response, error)
        }
        const parsed = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new MalformedProviderResponse({
                message:
                  "Azure Communication returned unreadable status",
                provider: "azure-communication",
                status: response.status,
                cause
              })
          )
        )
        return {
          providerMessageId: id,
          provider: "azure-communication",
          state: stateOf((parsed as { status?: string }).status)
        }
      })
    }

    return {
      destination,
      capabilities,
      send,
      retrieve
    }
  })

export const layer = (
  options: AzureCommunicationOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  Layer.effect(EmailTransport, make(options))
