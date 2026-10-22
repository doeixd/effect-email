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

export interface ScalewayOptions {
  readonly secretKey: Redacted.Redacted<string>
  readonly projectId: string
  readonly region?: string
  readonly baseUrl?: string
  readonly account?: string
}

export interface ScalewaySendResult {
  readonly id: ProviderMessageId
}

export interface ScalewayClient {
  readonly transport: Transport
  readonly sendEmail: (
    payload: ScalewayPayload
  ) => Effect.Effect<ScalewaySendResult, TransportError>
}

export class Client extends Context.Service<Client, ScalewayClient>()(
  "@effect-email/providers/Scaleway/Client"
) {}

export interface ScalewayAddress {
  readonly email: string
  readonly name?: string
}

export interface ScalewayAttachment {
  readonly name: string
  readonly type: string
  readonly content: string
}

export interface ScalewayHeader {
  readonly key: string
  readonly value: string
}

export interface ScalewayPayload {
  readonly from: ScalewayAddress
  readonly to: ReadonlyArray<ScalewayAddress>
  readonly cc?: ReadonlyArray<ScalewayAddress>
  readonly bcc?: ReadonlyArray<ScalewayAddress>
  readonly project_id: string
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly additional_headers?: ReadonlyArray<ScalewayHeader>
  readonly attachments?: ReadonlyArray<ScalewayAttachment>
}

export const ScalewaySuccess = Schema.Struct({
  emails: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.NonEmptyString),
        message_id: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(Schema.String),
        created_at: Schema.optionalKey(Schema.String)
      })
    )
  )
})

export const ScalewayErrorBody = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        argument_name: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String)
      })
    )
  )
})

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  maxRecipientsPerMessage: 10,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const MAX_EMAIL_BYTES = 2 * 1024 * 1024
const ATTACHMENT_LIMIT = 10

const formatAddress = (address: NormalizedAddress): ScalewayAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<ScalewayAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Scaleway does not accept remote attachment URLs",
        provider: "scaleway",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Scaleway adapter cannot read attachments from local paths; provide bytes instead",
        provider: "scaleway",
        capability: "attachments"
      })
    )
  }
  if (attachment.contentType === undefined) {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Scaleway attachments require an explicit contentType",
        provider: "scaleway",
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
    type: attachment.contentType,
    content
  })
}

const payloadFor = (
  message: PreparedMessage,
  projectId: string
): Effect.Effect<ScalewayPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Scaleway adapter supports rendered content only, received ${message.content._tag}`,
        provider: "scaleway",
        capability: "content"
      })
    )
  }
  if (message.attachments.length > ATTACHMENT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Scaleway accepts at most ${ATTACHMENT_LIMIT} attachments, got ${message.attachments.length}`,
        provider: "scaleway",
        capability: "attachments"
      })
    )
  }
  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const headers: Array<ScalewayHeader> = message.headers.map(
        ([key, value]) => ({ key, value })
      )
      if (message.replyTo.length > 0) {
        headers.push({
          key: "Reply-To",
          value: message.replyTo.map(formatAddress).map((address) =>
            address.name === undefined
              ? address.email
              : `"${address.name.replace(/"/g, '\\"')}" <${address.email}>`
          ).join(", ")
        })
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
        project_id: projectId,
        subject: message.subject,
        ...(content.text === undefined ? {} : { text: content.text }),
        ...(content.html === undefined ? {} : { html: content.html }),
        ...(headers.length === 0 ? {} : { additional_headers: headers }),
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

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<typeof ScalewayErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(ScalewayErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof ScalewayErrorBody.Type
): TransportError => {
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message: body.message ?? `Scaleway request failed with status ${response.status}`,
    provider: "scaleway",
    status: response.status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }

  if (body.type === "quotas_exceeded") {
    return new RateLimited({
      ...common,
      retryable: false,
      message: body.message ?? "quota exceeded"
    })
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

  const details = (body.details ?? [])
    .map((detail) =>
      [detail.argument_name, detail.reason].filter(Boolean).join(" ")
    )
    .filter((part) => part.length > 0)
  return new ProviderRejected({
    ...common,
    message:
      details.length === 0
        ? common.message
        : `${body.message ?? "invalid arguments"}: ${details.join("; ")}`
  })
}

const execute = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
  client.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new TransportUnavailable({
          message: "Scaleway request failed before a response was received",
          provider: "scaleway",
          retryable: true,
          cause
        })
    )
  )

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: ScalewayOptions
) =>
  Effect.fn("Scaleway.sendEmail")(function* (
    payload: ScalewayPayload
  ): Effect.fn.Return<ScalewaySendResult, TransportError> {
    const body = JSON.stringify(payload)
    const size = new TextEncoder().encode(body).byteLength
    if (size > MAX_EMAIL_BYTES) {
      return yield* new UnsupportedCapability({
        message: `Scaleway accepts at most ${MAX_EMAIL_BYTES} bytes per email, got ${size}`,
        provider: "scaleway",
        capability: "message-size"
      })
    }

    const region = options.region ?? "fr-par"
    const endpoint = (
      options.baseUrl ?? "https://api.scaleway.com"
    ).replace(/\/$/, "")
    const request = pipe(
      HttpClientRequest.post(
        `${endpoint}/transactional-email/v1alpha1/regions/${encodeURIComponent(region)}/emails`
      ),
      HttpClientRequest.setHeader(
        "X-Auth-Token",
        Redacted.value(options.secretKey)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* execute(client, request)

    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readErrorBody(response))
    }

    const raw = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Scaleway returned an unreadable success response",
            provider: "scaleway",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(ScalewaySuccess)(
      raw
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Scaleway returned an unreadable success response",
            provider: "scaleway",
            status: response.status,
            cause
          })
      )
    )
    const id = decoded.emails?.[0]?.id
    if (id === undefined) {
      return yield* new MalformedProviderResponse({
        message: "Scaleway success response did not contain an email id",
        provider: "scaleway",
        status: response.status,
        cause: raw
      })
    }
    return { id: providerMessageId(id) }
  })

const makeTransport = (
  options: ScalewayOptions,
  sendEmail: ScalewayClient["sendEmail"]
): Transport => {
  const destination = makeDestination({
    provider: "scaleway",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("Scaleway.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message, options.projectId)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload)
    return {
      deliveryId: envelope.deliveryId,
      provider: "scaleway",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route
    }
  })

  return { destination, capabilities, send }
}

export const makeClient = (
  options: ScalewayOptions
): Effect.Effect<ScalewayClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: ScalewayOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: ScalewayOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: ScalewayOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: ScalewayOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<ScalewayOptions, "secretKey" | "projectId"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        secretKey: Config.Redacted("SCW_SECRET_KEY"),
        projectId: Config.String("SCW_PROJECT_ID")
      }),
      ({ secretKey, projectId }) =>
        layerTransport({ ...options, secretKey, projectId })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "scaleway", account })
