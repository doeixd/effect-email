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
  Transport,
  TransportCapabilities
} from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export interface PostmarkOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly account?: string
  readonly messageStream?: string
}

export interface PostmarkSendResult {
  readonly id: ProviderMessageId
  readonly requestId?: string
}

export interface PostmarkClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: PostmarkPayload
  ) => Effect.Effect<PostmarkSendResult, TransportError>
  readonly sendEmailBatch: (
    payloads: ReadonlyArray<PostmarkPayload>
  ) => Effect.Effect<
    ReadonlyArray<typeof PostmarkResponse.Type>,
    TransportError
  >
}

export class Client extends Context.Service<Client, PostmarkClient>()(
  "@effect-email/providers/Postmark/Client"
) {}

export const PostmarkResponse = Schema.Struct({
  MessageID: Schema.optionalKey(Schema.String),
  ErrorCode: Schema.optionalKey(Schema.Number),
  Message: Schema.optionalKey(Schema.String),
  SubmittedAt: Schema.optionalKey(Schema.String),
  To: Schema.optionalKey(Schema.String)
})

export const PostmarkErrorBody = Schema.Struct({
  ErrorCode: Schema.optionalKey(Schema.Number),
  Message: Schema.optionalKey(Schema.String)
})

export interface PostmarkHeader {
  readonly Name: string
  readonly Value: string
}

export interface PostmarkAttachment {
  readonly Name: string
  readonly Content: string
  readonly ContentType?: string
  readonly ContentID?: string
}

export interface PostmarkPayload {
  readonly From: string
  readonly To: string
  readonly Cc?: string
  readonly Bcc?: string
  readonly Subject: string
  readonly TextBody?: string
  readonly HtmlBody?: string
  readonly ReplyTo?: string
  readonly Headers?: ReadonlyArray<PostmarkHeader>
  readonly Attachments?: ReadonlyArray<PostmarkAttachment>
  readonly MessageStream?: string
}

export const capabilities: TransportCapabilities & {
  readonly nativeBatch: true
} = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 500,
  maxRecipientsPerMessage: 50,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
}) as TransportCapabilities & { readonly nativeBatch: true }

const formatAddress = (address: NormalizedAddress): string =>
  address.name === undefined
    ? address.address
    : `"${address.name.replace(/"/g, '\\"')}" <${address.address}>`

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<PostmarkAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Postmark adapter requires attachment bytes; remote and path sources are not supported",
        provider: "postmark",
        capability: attachment.source._tag === "url"
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
    Name: attachment.filename,
    Content: content,
    ...(attachment.contentType === undefined
      ? {}
      : { ContentType: attachment.contentType }),
    ...(attachment.contentId === undefined
      ? {}
      : { ContentID: attachment.contentId })
  })
}

const payloadFor = (
  message: PreparedMessage,
  messageStream: string
): Effect.Effect<PostmarkPayload, TransportError> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Postmark adapter supports rendered content only, received ${message.content._tag}`,
        provider: "postmark",
        capability: "content"
      })
    )
  }

  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => ({
      From: formatAddress(message.from),
      To: message.to.map(formatAddress).join(", "),
      ...(message.cc.length === 0
        ? {}
        : { Cc: message.cc.map(formatAddress).join(", ") }),
      ...(message.bcc.length === 0
        ? {}
        : { Bcc: message.bcc.map(formatAddress).join(", ") }),
      Subject: message.subject,
      ...(content.text === undefined ? {} : { TextBody: content.text }),
      ...(content.html === undefined ? {} : { HtmlBody: content.html }),
      ...(message.replyTo.length === 0
        ? {}
        : { ReplyTo: message.replyTo.map(formatAddress).join(", ") }),
      ...(message.headers.length === 0
        ? {}
        : {
            Headers: message.headers.map(([Name, Value]) => ({
              Name,
              Value
            }))
          }),
      ...(attachments.length === 0 ? {} : { Attachments: attachments }),
      MessageStream: messageStream
    }))
  )
}

const requestIdFor = (
  response: HttpClientResponse.HttpClientResponse
): string | undefined =>
  Option.getOrUndefined(Headers.get(response.headers, "x-request-id"))

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
  response?: HttpClientResponse.HttpClientResponse
): TransportError => {
  const requestId =
    response === undefined ? undefined : requestIdFor(response)
  const retryAfterMillis =
    response === undefined
      ? undefined
      : parseRetryAfter(
          Option.getOrUndefined(
            Headers.get(response.headers, "retry-after")
          )
        )
  const common = {
    message,
    provider: "postmark",
    status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
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

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<typeof PostmarkErrorBody.Type> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(PostmarkErrorBody)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const httpFailure = (
  response: HttpClientResponse.HttpClientResponse,
  message: string
): Effect.Effect<never, TransportError> =>
  Effect.flatMap(readErrorBody(response), (body) =>
    Effect.fail(
      classifyFailure(
        response.status,
        body.Message ?? message,
        response
      )
    )
  )

const makeHeaders = (
  token: Redacted.Redacted<string>
): (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest =>
  (request) =>
    pipe(
      request,
      HttpClientRequest.setHeader(
        "X-Postmark-Server-Token",
        Redacted.value(token)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json")
    )

const decodeResponse = (
  body: unknown
): Effect.Effect<typeof PostmarkResponse.Type, MalformedProviderResponse> =>
  Schema.decodeUnknownEffect(PostmarkResponse)(body).pipe(
    Effect.mapError(
      (issue) =>
        new MalformedProviderResponse({
          message: "Postmark returned a malformed response",
          provider: "postmark",
          cause: issue
        })
    )
  )

const responseOutcome = (
  response: typeof PostmarkResponse.Type,
  envelope: PreparedEnvelope,
  index: number
): MessageOutcome => {
  const errorCode = response.ErrorCode ?? 0
  if (errorCode === 0) {
    if (response.MessageID === undefined || response.MessageID.length === 0) {
      return {
        _tag: "uncertain",
        index,
        error: new MalformedProviderResponse({
          message: "Postmark accepted a message without a MessageID",
          provider: "postmark",
          status: 200
        })
      }
    }
    return {
      _tag: "accepted",
      index,
      receipt: {
        deliveryId: envelope.deliveryId,
        provider: "postmark",
        destinationId: envelope.destinationId,
        providerMessageId: providerMessageId(response.MessageID),
        acceptedAt: DateTime.makeUnsafe(new Date()),
        route: envelope.route
      }
    }
  }

  const error = classifyFailure(
    errorCode,
    response.Message ?? `Postmark rejected the message with code ${errorCode}`
  )
  return certaintyOf(error) === "unknown"
    ? { _tag: "uncertain", index, error }
    : { _tag: "rejected", index, error }
}

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: PostmarkOptions,
  baseUrl: string
) =>
  Effect.fn("Postmark.sendEmail")(function* (
    payload: PostmarkPayload
  ): Effect.fn.Return<PostmarkSendResult, TransportError> {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/email`),
      makeHeaders(options.apiKey),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "Postmark request failed before a response was received; outcome is unknown",
            provider: "postmark",
            cause
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* httpFailure(response, "Postmark rejected the message")
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Postmark returned an unreadable success response",
            provider: "postmark",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* decodeResponse(body)
    if (decoded.ErrorCode !== undefined && decoded.ErrorCode !== 0) {
      return yield* Effect.fail(
        classifyFailure(
          decoded.ErrorCode,
          decoded.Message ?? "Postmark rejected the message"
        )
      )
    }
    if (decoded.MessageID === undefined || decoded.MessageID.length === 0) {
      return yield* new MalformedProviderResponse({
        message: "Postmark success response did not contain a MessageID",
        provider: "postmark",
        status: response.status
      })
    }

    const requestId = requestIdFor(response)
    return {
      id: providerMessageId(decoded.MessageID),
      ...(requestId === undefined ? {} : { requestId })
    }
  })

const makeSendEmailBatch = (
  client: HttpClient.HttpClient,
  options: PostmarkOptions,
  baseUrl: string
) =>
  Effect.fn("Postmark.sendEmailBatch")(function* (
    payloads: ReadonlyArray<PostmarkPayload>
  ): Effect.fn.Return<
    ReadonlyArray<typeof PostmarkResponse.Type>,
    TransportError
  > {
    const request = pipe(
      HttpClientRequest.post(`${baseUrl}/email/batch`),
      makeHeaders(options.apiKey),
      HttpClientRequest.bodyJsonUnsafe(payloads)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "Postmark batch request failed before a response was received; outcome is unknown",
            provider: "postmark",
            cause
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* httpFailure(response, "Postmark rejected the batch")
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Postmark returned an unreadable batch response",
            provider: "postmark",
            status: response.status,
            cause
          })
      )
    )
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(PostmarkResponse)
    )(body).pipe(
      Effect.mapError(
        (issue) =>
          new MalformedProviderResponse({
            message: "Postmark batch response was malformed",
            provider: "postmark",
            status: response.status,
            cause: issue
          })
      )
    )
  })

const makeTransport = (
  options: PostmarkOptions,
  sendEmail: PostmarkClient["sendEmail"],
  sendEmailBatch: PostmarkClient["sendEmailBatch"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "postmark",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)
  const messageStream = options.messageStream ?? "outbound"

  const send = Effect.fn("Postmark.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message, messageStream)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload)

    return {
      deliveryId: envelope.deliveryId,
      provider: "postmark",
      destinationId: resolvedDestinationId,
      providerMessageId: result.id,
      acceptedAt,
      route: envelope.route,
      ...(result.requestId === undefined
        ? {}
        : { requestId: result.requestId })
    }
  })

  const classifyBatchFailure = (
    index: number,
    error: TransportError
  ): MessageOutcome =>
    certaintyOf(error) === "unknown"
      ? { _tag: "uncertain", index, error }
      : { _tag: "rejected", index, error }

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Postmark.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const prepared = yield* Effect.forEach(envelopes, (envelope) =>
      Effect.result(payloadFor(envelope.message, messageStream))
    )

    const local: Array<MessageOutcome> = []
    const valid: Array<{
      readonly position: number
      readonly envelope: PreparedEnvelope
      readonly payload: PostmarkPayload
    }> = []
    for (const [position, result] of prepared.entries()) {
      if (result._tag === "Failure") {
        local.push({
          _tag: "invalid",
          index: position,
          error: result.failure
        })
      } else {
        valid.push({
          position,
          envelope: envelopes[position]!,
          payload: result.success
        })
      }
    }

    if (valid.length === 0) {
      return local.sort((left, right) => left.index - right.index)
    }

    const request = yield* Effect.result(
      sendEmailBatch(valid.map((entry) => entry.payload))
    )
    let remote: ReadonlyArray<MessageOutcome>
    if (request._tag === "Failure") {
      remote = valid.map((entry) =>
        classifyBatchFailure(entry.position, request.failure)
      )
    } else {
      remote = valid.map((entry, offset) => {
        const response = request.success[offset]
        if (response === undefined) {
          return {
            _tag: "uncertain" as const,
            index: entry.position,
            error: new DeliveryUncertain({
              message:
                "Postmark batch response omitted this message; submission state is unknown",
              provider: "postmark",
              status: 200
            })
          }
        }
        return responseOutcome(response, entry.envelope, entry.position)
      })
    }

    return [...local, ...remote].sort(
      (left, right) => left.index - right.index
    )
  })

  return {
    destination,
    capabilities,
    send,
    sendBatch
  }
}

export const makeClient = (
  options: PostmarkOptions
): Effect.Effect<PostmarkClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = options.baseUrl ?? "https://api.postmarkapp.com"
    const sendEmail = makeSendEmail(httpClient, options, baseUrl)
    const sendEmailBatch = makeSendEmailBatch(httpClient, options, baseUrl)
    return {
      transport: makeTransport(options, sendEmail, sendEmailBatch),
      sendEmail,
      sendEmailBatch
    }
  })

export const make = (
  options: PostmarkOptions
): Effect.Effect<NativeBatchTransport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: PostmarkOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: PostmarkOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: PostmarkOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<PostmarkOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("POSTMARK_SERVER_TOKEN"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "postmark", account })

