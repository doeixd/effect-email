import {
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema
} from "effect"
import { Base64 } from "effect/encoding"
import { createHash, createHmac } from "node:crypto"
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
  DeliveryUncertain,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import { buildMime } from "../smtp/Mime"

export interface SesOptions {
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string>
  readonly region: string
  readonly baseUrl?: string
  readonly account?: string
  readonly configurationSetName?: string
}

export const SesSuccess = Schema.Struct({
  MessageId: Schema.optionalKey(Schema.NonEmptyString)
})

export const SesErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  Message: Schema.optionalKey(Schema.String),
  __type: Schema.optionalKey(Schema.String)
})

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: true,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

const hmac = (
  key: Uint8Array | string,
  value: string
): Uint8Array => createHmac("sha256", key).update(value).digest()

const formatAddress = (
  address: PreparedEnvelope["message"]["from"]
): string => {
  if (address.name === undefined) {
    return address.address
  }
  const encoded = /^[\x20-\x7E]*$/.test(address.name)
    ? /[",<>@;:\\]/.test(address.name)
      ? `"${address.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
      : address.name
    : `=?UTF-8?B?${Base64.encode(
        new TextEncoder().encode(address.name)
      )}?=`
  return `${encoded} <${address.address}>`
}

const amzDate = (date: Date): string =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "")

const signRequest = (
  options: SesOptions,
  url: URL,
  body: string,
  now: Date
): Readonly<Record<string, string>> => {
  const timestamp = amzDate(now)
  const day = timestamp.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp
  }
  if (options.sessionToken !== undefined) {
    headers["x-amz-security-token"] = Redacted.value(
      options.sessionToken
    )
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name]}\n`)
    .join("")
  const signedHeaders = names.join(";")
  const canonicalRequest = [
    "POST",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n")
  const scope = `${day}/${options.region}/ses/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n")
  const dateKey = hmac(
    `AWS4${Redacted.value(options.secretAccessKey)}`,
    day
  )
  const regionKey = hmac(dateKey, options.region)
  const serviceKey = hmac(regionKey, "ses")
  const signingKey = hmac(serviceKey, "aws4_request")
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex")
  return {
    "X-Amz-Date": timestamp,
    "X-Amz-Content-Sha256": payloadHash,
    ...(options.sessionToken === undefined
      ? {}
      : {
          "X-Amz-Security-Token": Redacted.value(
            options.sessionToken
          )
        }),
    Authorization: `AWS4-HMAC-SHA256 Credential=${
      options.accessKeyId
    }/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

const parseRetryAfter = (value: string): number | undefined => {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const headerValue = (
  response: HttpClientResponse.HttpClientResponse,
  name: string
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, name))

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof SesErrorBody.Type
): TransportError => {
  const message =
    body.message ??
    body.Message ??
    body.__type ??
    `SES request failed with status ${response.status}`
  const retryAfter = headerValue(response, "retry-after")
  const retryAfterMillis =
    retryAfter === undefined ? undefined : parseRetryAfter(retryAfter)
  const common = {
    message,
    provider: "ses",
    status: response.status,
    ...(retryAfterMillis === undefined
      ? {}
      : { retryAfterMillis }),
    ...(headerValue(response, "x-amzn-requestid") === undefined
      ? {}
      : {
          requestId: headerValue(response, "x-amzn-requestid")
        })
  }
  const type = body.__type ?? ""
  if (
    type.includes("ThrottlingException") ||
    type.includes("LimitExceededException") ||
    type.includes("TooManyRequestsException")
  ) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationFailed(common)
  }
  if (response.status === 429) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return new DeliveryUncertain(common)
  }
  return new ProviderRejected(common)
}

const receiptFor = (
  envelope: PreparedEnvelope,
  destinationIdValue: ReturnType<typeof destinationId>,
  id: string,
  acceptedAt: DateTime.Utc,
  requestId: string | undefined
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "ses",
  destinationId: destinationIdValue,
  providerMessageId: providerMessageId(id),
  acceptedAt,
  route: envelope.route,
  ...(requestId === undefined ? {} : { requestId })
})

export const make = (
  options: SesOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const destination: Destination = makeDestination({
      provider: "ses",
      account: options.account ?? options.region
    })
    const resolvedDestinationId = destinationId(destination)
    const baseUrl =
      options.baseUrl ?? `https://email.${options.region}.amazonaws.com`

    const send = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.gen(function* () {
        const recipients =
          envelope.message.to.length +
          envelope.message.cc.length +
          envelope.message.bcc.length
        if (recipients > 50) {
          return yield* new UnsupportedCapability({
            message: `SES accepts at most 50 recipients, got ${recipients}`,
            provider: "ses",
            capability: "recipients"
          })
        }
        if (envelope.message.tags.length > 50) {
          return yield* new UnsupportedCapability({
            message: "SES accepts at most 50 tags",
            provider: "ses",
            capability: "tags"
          })
        }
        if (
          envelope.message.tags.some(
            (tag) => !/^[A-Za-z0-9_-]{1,256}$/.test(tag)
          )
        ) {
          return yield* new UnsupportedCapability({
            message:
              "SES tags may contain only letters, digits, underscores, and hyphens",
            provider: "ses",
            capability: "tags"
          })
        }
        const mime = yield* buildMime(envelope.message)
        if (mime.byteLength > 10 * 1024 * 1024) {
          return yield* new UnsupportedCapability({
            message: "SES raw messages may not exceed 10 MiB",
            provider: "ses",
            capability: "message-size"
          })
        }
        const payload = JSON.stringify({
          FromEmailAddress: formatAddress(envelope.message.from),
          Destination: {
            ToAddresses: envelope.message.to.map(
              (address) => address.address
            ),
            ...(envelope.message.cc.length === 0
              ? {}
              : {
                  CcAddresses: envelope.message.cc.map(
                    (address) => address.address
                  )
                }),
            ...(envelope.message.bcc.length === 0
              ? {}
              : {
                  BccAddresses: envelope.message.bcc.map(
                    (address) => address.address
                  )
                })
          },
          ...(envelope.message.replyTo.length === 0
            ? {}
            : {
                ReplyToAddresses: envelope.message.replyTo.map(
                  (address) => address.address
                )
              }),
          Content: {
            Raw: {
              Data: Buffer.from(mime).toString("base64")
            }
          },
          ...(envelope.message.tags.length === 0
            ? {}
            : {
                EmailTags: envelope.message.tags.map((tag) => ({
                  Name: tag,
                  Value: ""
                }))
              }),
          ...(options.configurationSetName === undefined
            ? {}
            : {
                ConfigurationSetName: options.configurationSetName
              })
        })
        const url = new URL(
          "/v2/email/outbound-emails",
          baseUrl
        )
        const signatureHeaders = signRequest(
          options,
          url,
          payload,
          new Date()
        )
        let request = HttpClientRequest.post(url.toString())
        for (const [name, value] of Object.entries(
          signatureHeaders
        )) {
          request = HttpClientRequest.setHeader(
            request,
            name,
            value
          )
        }
        request = HttpClientRequest.setHeader(
          request,
          "Accept",
          "application/json"
        )
        request = HttpClientRequest.bodyText(
          request,
          payload,
          "application/json"
        )
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new TransportUnavailable({
                message: "SES request failed before a response",
                provider: "ses",
                retryable: true,
                cause
              })
          )
        )
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.json.pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(SesErrorBody)(value).pipe(
                Effect.orElseSucceed(() => ({}))
              )
            ),
            Effect.orElseSucceed(() => ({}))
          )
          return yield* classifyFailure(response, body)
        }
        const body = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new MalformedProviderResponse({
                message: "SES returned an unreadable response",
                provider: "ses",
                status: response.status,
                cause
              })
          )
        )
        const decoded = yield* Schema.decodeUnknownEffect(SesSuccess)(
          body
        ).pipe(
          Effect.mapError(
            (cause) =>
              new MalformedProviderResponse({
                message: "SES response did not contain a MessageId",
                provider: "ses",
                status: response.status,
                cause
              })
          )
        )
        if (decoded.MessageId === undefined) {
          return yield* new MalformedProviderResponse({
            message: "SES response did not contain a MessageId",
            provider: "ses",
            status: response.status,
            cause: body
          })
        }
        const acceptedAt = yield* DateTime.now
        return receiptFor(
          envelope,
          resolvedDestinationId,
          decoded.MessageId,
          acceptedAt,
          headerValue(response, "x-amzn-requestid")
        )
      })

    return {
      destination,
      capabilities,
      send
    }
  })

export const layer = (
  options: SesOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  Layer.effect(EmailTransport, make(options))
