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
  DeliveryUncertain,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
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

export interface MailjetOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly apiSecret: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
  readonly sandbox?: boolean
}

export interface MailjetClient {
  readonly transport: NativeBatchTransport
  readonly sendMessages: (
    payload: MailjetRequest
  ) => Effect.Effect<
    ReadonlyArray<typeof MailjetMessage.Type>,
    TransportError
  >
}

export class Client extends Context.Service<Client, MailjetClient>()(
  "@effect-email/providers/Mailjet/Client"
) {}

export const MailjetMessage = Schema.Struct({
  Status: Schema.optionalKey(Schema.String),
  To: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        Email: Schema.optionalKey(Schema.String),
        MessageUUID: Schema.optionalKey(Schema.String),
        MessageID: Schema.optionalKey(Schema.Number)
      })
    )
  ),
  Cc: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        Email: Schema.optionalKey(Schema.String),
        MessageUUID: Schema.optionalKey(Schema.String),
        MessageID: Schema.optionalKey(Schema.Number)
      })
    )
  ),
  Bcc: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        Email: Schema.optionalKey(Schema.String),
        MessageUUID: Schema.optionalKey(Schema.String),
        MessageID: Schema.optionalKey(Schema.Number)
      })
    )
  ),
  Errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ErrorCode: Schema.optionalKey(Schema.String),
        StatusCode: Schema.optionalKey(Schema.Number),
        ErrorMessage: Schema.optionalKey(Schema.String),
        ErrorRelatedTo: Schema.optionalKey(Schema.Array(Schema.String))
      })
    )
  )
})

export const MailjetResponse = Schema.Struct({
  Messages: Schema.Array(MailjetMessage)
})

export interface MailjetAddress {
  readonly Email: string
  readonly Name?: string
}

export interface MailjetAttachment {
  readonly ContentType: string
  readonly Filename: string
  readonly Base64Content: string
  readonly ContentID?: string
}

export interface MailjetMessagePayload {
  readonly From: MailjetAddress
  readonly To: ReadonlyArray<MailjetAddress>
  readonly Cc?: ReadonlyArray<MailjetAddress>
  readonly Bcc?: ReadonlyArray<MailjetAddress>
  readonly ReplyTo?: MailjetAddress
  readonly Subject: string
  readonly TextPart?: string
  readonly HTMLPart?: string
  readonly Attachments?: ReadonlyArray<MailjetAttachment>
  readonly InlinedAttachments?: ReadonlyArray<MailjetAttachment>
  readonly Headers?: Readonly<Record<string, string>>
  readonly CustomID?: string
}

export interface MailjetRequest {
  readonly Messages: ReadonlyArray<MailjetMessagePayload>
  readonly SandboxMode?: boolean
}

export const capabilities: TransportCapabilities & {
  readonly nativeBatch: true
} = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 100,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
}) as TransportCapabilities & { readonly nativeBatch: true }

const RECIPIENT_LIMIT = 50
const SUBJECT_LIMIT = 255

const formatAddress = (address: NormalizedAddress): MailjetAddress =>
  address.name === undefined
    ? { Email: address.address }
    : { Email: address.address, Name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<MailjetAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Mailjet adapter requires attachment bytes; remote and path sources are not supported",
        provider: "mailjet",
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
    ContentType: attachment.contentType ?? "application/octet-stream",
    Filename: attachment.filename,
    Base64Content: content,
    ...(attachment.contentId === undefined
      ? {}
      : { ContentID: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage,
  providerIdempotencyKey: string | undefined
): Effect.Effect<MailjetMessagePayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailjet adapter supports rendered content only, received ${message.content._tag}`,
        provider: "mailjet",
        capability: "content"
      })
    )
  }
  if (message.subject.length > SUBJECT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailjet subjects are limited to ${SUBJECT_LIMIT} characters`,
        provider: "mailjet",
        capability: "subject-length"
      })
    )
  }
  if (message.replyTo.length > 1) {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Mailjet accepts at most one reply-to address",
        provider: "mailjet",
        capability: "reply-to"
      })
    )
  }

  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const files = message.attachments
        .map((attachment, index) => ({ attachment, mapped: attachments[index]! }))
        .filter(({ attachment }) => attachment.contentId === undefined)
      const inline = message.attachments
        .map((attachment, index) => ({ attachment, mapped: attachments[index]! }))
        .filter(({ attachment }) => attachment.contentId !== undefined)

      return {
        From: formatAddress(message.from),
        To: message.to.map(formatAddress),
        ...(message.cc.length === 0
          ? {}
          : { Cc: message.cc.map(formatAddress) }),
        ...(message.bcc.length === 0
          ? {}
          : { Bcc: message.bcc.map(formatAddress) }),
        ...(message.replyTo.length === 0
          ? {}
          : { ReplyTo: formatAddress(message.replyTo[0]!) }),
        Subject: message.subject,
        ...(content.text === undefined ? {} : { TextPart: content.text }),
        ...(content.html === undefined ? {} : { HTMLPart: content.html }),
        ...(files.length === 0
          ? {}
          : { Attachments: files.map(({ mapped }) => mapped) }),
        ...(inline.length === 0
          ? {}
          : {
              InlinedAttachments: inline.map(({ mapped }) => mapped)
            }),
        ...(message.headers.length === 0
          ? {}
          : { Headers: Object.fromEntries(message.headers) }),
        ...(providerIdempotencyKey === undefined
          ? {}
          : { CustomID: providerIdempotencyKey })
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

const classifyStatus = (
  status: number,
  response?: HttpClientResponse.HttpClientResponse
): TransportError => {
  const retryAfterMillis =
    response === undefined
      ? undefined
      : parseRetryAfter(headerValue(response, "retry-after"))
  const requestId =
    response === undefined ? undefined : headerValue(response, "x-request-id")
  const common = {
    message: `Mailjet request failed with status ${status}`,
    provider: "mailjet",
    status,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
    ...(requestId === undefined ? {} : { requestId })
  }
  if (status === 401 || status === 403) {
    return new AuthenticationFailed(common)
  }
  if (status === 429) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (status >= 500) {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

const messageFailure = (
  entry: typeof MailjetMessage.Type,
  index: number
): MessageOutcome => {
  const errors = entry.Errors ?? []
  const status = errors.find((error) => error.StatusCode !== undefined)?.StatusCode
  const description =
    errors
      .map((error) => {
        const message =
          error.ErrorMessage ?? error.ErrorCode ?? "Mailjet rejected the message"
        return error.ErrorRelatedTo === undefined ||
          error.ErrorRelatedTo.length === 0
          ? message
          : `${error.ErrorRelatedTo.join(", ")}: ${message}`
      })
      .join("; ") || `Mailjet returned status ${entry.Status ?? "unknown"}`
  const error =
    status === undefined
      ? new ProviderRejected({
          message: description,
          provider: "mailjet"
        })
      : status === 429
        ? new RateLimited({
            message: description,
            provider: "mailjet",
            status,
            retryable: true
          })
        : status >= 500
          ? new TransportUnavailable({
              message: description,
              provider: "mailjet",
              status,
              retryable: true
            })
          : new ProviderRejected({
              message: description,
              provider: "mailjet",
              status
            })
  return certaintyOf(error) === "unknown"
    ? { _tag: "uncertain", index, error }
    : { _tag: "rejected", index, error }
}

const makeSendMessages = (
  client: HttpClient.HttpClient,
  options: MailjetOptions,
  baseUrl: string
) =>
  Effect.fn("Mailjet.sendMessages")(function* (
    payload: MailjetRequest
  ): Effect.fn.Return<
    ReadonlyArray<typeof MailjetMessage.Type>,
    TransportError
  > {
    const authorization = Base64.encode(
      new TextEncoder().encode(
        `${Redacted.value(options.apiKey)}:${Redacted.value(options.apiSecret)}`
      )
    )
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/v3.1/send`),
      HttpClientRequest.setHeader("Authorization", `Basic ${authorization}`),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "Mailjet request failed before a response was received; outcome is unknown",
            provider: "mailjet",
            cause
          })
      )
    )

    const body = yield* response.json.pipe(
      Effect.orElseSucceed(() => undefined)
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailjetResponse)(
      body
    ).pipe(Effect.result)

    if (decoded._tag === "Success") {
      return decoded.success.Messages
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* classifyStatus(response.status, response)
    }

    return yield* new MalformedProviderResponse({
      message: "Mailjet returned a success response without a Messages array",
      provider: "mailjet",
      status: response.status,
      cause: decoded.failure
    })
  })

const makeTransport = (
  options: MailjetOptions,
  sendMessages: MailjetClient["sendMessages"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "mailjet",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)
  const sandbox = options.sandbox ?? false

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Mailjet.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const prepared = yield* Effect.forEach(envelopes, (envelope) =>
      Effect.result(
        payloadFor(envelope.message, envelope.providerIdempotencyKey)
      )
    )

    const outcomes: Array<MessageOutcome> = []
    const valid: Array<{
      readonly index: number
      readonly envelope: PreparedEnvelope
      readonly payload: MailjetMessagePayload
    }> = []
    for (const [index, result] of prepared.entries()) {
      if (result._tag === "Failure") {
        outcomes.push({
          _tag: "invalid",
          index,
          error: result.failure
        })
      } else {
        valid.push({
          index,
          envelope: envelopes[index]!,
          payload: result.success
        })
      }
    }

    if (valid.length === 0) {
      return outcomes.sort((left, right) => left.index - right.index)
    }

    const calls: Array<typeof valid> = []
    let current: typeof valid = []
    let recipients = 0
    for (const entry of valid) {
      const unique = new Set(
        [
          ...entry.envelope.message.to,
          ...entry.envelope.message.cc,
          ...entry.envelope.message.bcc
        ].map((address) => address.address.toLowerCase())
      ).size
      if (current.length > 0 && recipients + unique > RECIPIENT_LIMIT) {
        calls.push(current)
        current = []
        recipients = 0
      }
      current.push(entry)
      recipients += unique
    }
    if (current.length > 0) {
      calls.push(current)
    }

    for (const call of calls) {
      const result = yield* Effect.result(
        sendMessages({
          Messages: call.map((entry) => entry.payload),
          ...(sandbox ? { SandboxMode: true } : {})
        })
      )
      if (result._tag === "Failure") {
        outcomes.push(
          ...call.map(
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
        )
        continue
      }

      const acceptedAt = yield* DateTime.now
      for (const [slot, entry] of call.entries()) {
        const response = result.success[slot]
        if (response === undefined) {
          outcomes.push({
            _tag: "uncertain",
            index: entry.index,
            error: new DeliveryUncertain({
              message: "Mailjet response omitted this message",
              provider: "mailjet",
              status: 200
            })
          })
          continue
        }
        if (response.Status !== "success") {
          outcomes.push(messageFailure(response, entry.index))
          continue
        }
        const recipient =
          response.To?.[0] ?? response.Cc?.[0] ?? response.Bcc?.[0]
        const id =
          recipient?.MessageUUID ??
          (recipient?.MessageID === undefined
            ? undefined
            : String(recipient.MessageID)) ??
          (sandbox ? "sandbox" : undefined)
        if (id === undefined || id.length === 0) {
          outcomes.push({
            _tag: "uncertain",
            index: entry.index,
            error: new MalformedProviderResponse({
              message: "Mailjet accepted the message without a MessageUUID",
              provider: "mailjet",
              status: 200
            })
          })
          continue
        }
        outcomes.push({
          _tag: "accepted",
          index: entry.index,
          receipt: {
            deliveryId: entry.envelope.deliveryId,
            provider: "mailjet",
            destinationId: resolvedDestinationId,
            providerMessageId: providerMessageId(id),
            acceptedAt,
            route: entry.envelope.route
          }
        })
      }
    }

    return outcomes.sort((left, right) => left.index - right.index)
  })

  const send = Effect.fn("Mailjet.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const outcomes = yield* sendBatch([envelope])
    const outcome = outcomes[0]!
    if (outcome._tag === "accepted") {
      return outcome.receipt
    }
    return yield* (outcome.error as TransportError)
  })

  return { destination, capabilities, send, sendBatch }
}

export const makeClient = (
  options: MailjetOptions
): Effect.Effect<MailjetClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? "https://api.mailjet.com"
    const sendMessages = makeSendMessages(httpClient, options, baseUrl)
    return {
      transport: makeTransport(options, sendMessages),
      sendMessages
    }
  })

export const make = (
  options: MailjetOptions
): Effect.Effect<NativeBatchTransport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailjetOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailjetOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailjetOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailjetOptions, "apiKey" | "apiSecret"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        apiKey: Config.Redacted("MAILJET_API_KEY"),
        apiSecret: Config.Redacted("MAILJET_API_SECRET")
      }),
      ({ apiKey, apiSecret }) =>
        layerTransport({ ...options, apiKey, apiSecret })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailjet", account })

