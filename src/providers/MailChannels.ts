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
  DeliveryUncertain,
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

export interface MailChannelsOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly campaignId?: string
  readonly envelopeFrom?: string
  readonly transactional?: boolean
  readonly trackingDomain?: string
  readonly unsubscribeDomain?: string
  readonly account?: string
}

export interface MailChannelsPersonalization {
  readonly to: ReadonlyArray<MailChannelsAddress>
  readonly from: MailChannelsAddress
  readonly subject: string
  readonly cc?: ReadonlyArray<MailChannelsAddress>
  readonly bcc?: ReadonlyArray<MailChannelsAddress>
  readonly reply_to?: MailChannelsAddress
  readonly headers?: Readonly<Record<string, string>>
}

export interface MailChannelsPayload {
  readonly content: ReadonlyArray<{
    readonly type: "text/plain" | "text/html"
    readonly value: string
  }>
  readonly from: MailChannelsAddress
  readonly subject: string
  readonly personalizations: ReadonlyArray<MailChannelsPersonalization>
  readonly attachments?: ReadonlyArray<MailChannelsAttachment>
  readonly campaign_id?: string
  readonly envelope_from?: MailChannelsAddress
  readonly transactional?: boolean
  readonly unsubscribe_settings?: { readonly custom_domain_name: string }
  readonly tracking_settings?: {
    readonly open_tracking?: {
      readonly enable: boolean
      readonly custom_domain_name?: string
    }
    readonly click_tracking?: {
      readonly enable: boolean
      readonly custom_domain_name?: string
    }
  }
}

export interface MailChannelsAddress {
  readonly email: string
  readonly name?: string
}

export interface MailChannelsAttachment {
  readonly filename: string
  readonly content: string
  readonly type?: string
  readonly content_id?: string
}

export interface MailChannelsResultEntry {
  readonly index: number
  readonly messageId?: ProviderMessageId
  readonly failure?: TransportError
}

export interface MailChannelsBatchResult {
  readonly requestId?: string
  readonly entries: ReadonlyArray<MailChannelsResultEntry>
}

export interface MailChannelsClient {
  readonly transport: NativeBatchTransport
  readonly sendEmail: (
    payload: MailChannelsPayload
  ) => Effect.Effect<MailChannelsBatchResult, TransportError>
}

export class Client extends Context.Service<Client, MailChannelsClient>()(
  "@effect-email/providers/MailChannels/Client"
) {}

export const MailChannelsSuccess = Schema.Struct({
  request_id: Schema.optionalKey(Schema.String),
  queued_at: Schema.optionalKey(Schema.String),
  results: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: Schema.optionalKey(Schema.Int),
        message_id: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String)
      })
    )
  ),
  data: Schema.optionalKey(Schema.Array(Schema.String)),
  errors: Schema.optionalKey(Schema.Array(Schema.String))
})

type MailChannelsBody = typeof MailChannelsSuccess.Type

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 1000,
  maxRecipientsPerMessage: 1000,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

type MailChannelsShared = Omit<
  MailChannelsPayload,
  "from" | "subject" | "personalizations"
>

const BATCH_LIMIT = 1000
const RECIPIENT_LIMIT = 1000
const ATTACHMENT_LIMIT = 1000
const CAMPAIGN_ID_LIMIT = 48
const CAMPAIGN_TAG = "campaign"

const badCampaignId = (value: string): boolean =>
  [...value].length > CAMPAIGN_ID_LIMIT || /\s/.test(value)

const formatAddress = (address: NormalizedAddress): MailChannelsAddress =>
  address.name === undefined
    ? { email: address.address }
    : { email: address.address, name: address.name }

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<MailChannelsAttachment, UnsupportedCapability> => {
  if (attachment.source._tag !== "content") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "MailChannels requires attachment bytes; provide content instead of a path or URL",
        provider: "mailchannels",
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
    ...(attachment.contentType === undefined
      ? {}
      : { type: attachment.contentType }),
    ...(attachment.contentId === undefined
      ? {}
      : { content_id: attachment.contentId })
  })
}

const campaignOf = (
  message: PreparedMessage,
  options: MailChannelsOptions
): string | undefined =>
  message.tags.includes(CAMPAIGN_TAG) ? CAMPAIGN_TAG : options.campaignId

const sharedFor = (
  message: PreparedMessage,
  options: MailChannelsOptions
): Effect.Effect<
  Pick<
    MailChannelsPayload,
    | "content"
    | "attachments"
    | "campaign_id"
    | "envelope_from"
    | "transactional"
    | "unsubscribe_settings"
    | "tracking_settings"
  >,
  TransportError
> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailChannels adapter supports rendered content only, received ${message.content._tag}`,
        provider: "mailchannels",
        capability: "content"
      })
    )
  }
  const recipients =
    message.to.length + message.cc.length + message.bcc.length
  if (recipients > RECIPIENT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailChannels accepts at most ${RECIPIENT_LIMIT} recipients, got ${recipients}`,
        provider: "mailchannels",
        capability: "recipients"
      })
    )
  }
  if (message.attachments.length > ATTACHMENT_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailChannels accepts at most ${ATTACHMENT_LIMIT} attachments, got ${message.attachments.length}`,
        provider: "mailchannels",
        capability: "attachments"
      })
    )
  }
  const campaign = campaignOf(message, options)
  if (campaign !== undefined && badCampaignId(campaign)) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `MailChannels campaign ids may be at most ${CAMPAIGN_ID_LIMIT} characters and contain no spaces`,
        provider: "mailchannels",
        capability: "tags"
      })
    )
  }
  const content = message.content
  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => ({
      content: [
        ...(content.text === undefined
          ? []
          : [{ type: "text/plain" as const, value: content.text }]),
        ...(content.html === undefined
          ? []
          : [{ type: "text/html" as const, value: content.html }])
      ],
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(campaign === undefined ? {} : { campaign_id: campaign }),
      ...(options.envelopeFrom === undefined
        ? {}
        : { envelope_from: { email: options.envelopeFrom } }),
      ...(options.transactional === undefined
        ? {}
        : { transactional: options.transactional }),
      ...(options.unsubscribeDomain === undefined
        ? {}
        : {
            unsubscribe_settings: {
              custom_domain_name: options.unsubscribeDomain
            }
          }),
      ...(options.trackingDomain === undefined
        ? {}
        : {
            tracking_settings: {
              open_tracking: {
                enable: true,
                custom_domain_name: options.trackingDomain
              },
              click_tracking: {
                enable: true,
                custom_domain_name: options.trackingDomain
              }
            }
          })
    }))
  )
}

const personalizationFor = (
  message: PreparedMessage
): Effect.Effect<MailChannelsPersonalization, UnsupportedCapability> => {
  if (message.replyTo.length > 1) {
    return Effect.fail(
      new UnsupportedCapability({
        message: "MailChannels accepts a single reply-to address",
        provider: "mailchannels",
        capability: "reply-to"
      })
    )
  }
  const headers: Record<string, string> = Object.fromEntries(message.headers)
  for (const tag of message.tags) {
    if (tag !== CAMPAIGN_TAG) {
      headers[`X-Tag-${tag}`] = "true"
    }
  }
  return Effect.succeed({
    to: message.to.map(formatAddress),
    from: formatAddress(message.from),
    subject: message.subject,
    ...(message.cc.length === 0
      ? {}
      : { cc: message.cc.map(formatAddress) }),
    ...(message.bcc.length === 0
      ? {}
      : { bcc: message.bcc.map(formatAddress) }),
    ...(message.replyTo.length === 0
      ? {}
      : { reply_to: formatAddress(message.replyTo[0]!) }),
    ...(Object.keys(headers).length === 0 ? {} : { headers })
  })
}

const payloadFor = (
  message: PreparedMessage,
  options: MailChannelsOptions
): Effect.Effect<MailChannelsPayload, TransportError> =>
  Effect.gen(function* () {
    const shared = yield* sharedFor(message, options)
    const personalizations = [yield* personalizationFor(message)]
    return {
      ...shared,
      from: formatAddress(message.from),
      subject: message.subject,
      personalizations
    }
  })

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

const readErrorBody = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<MailChannelsBody> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(MailChannelsSuccess)(body).pipe(
        Effect.orElseSucceed(() => ({}))
      )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: MailChannelsBody
): TransportError => {
  const message =
    body.errors?.join("; ") ??
    `MailChannels request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "mailchannels",
    status: response.status,
    ...(body.request_id === undefined ? {} : { requestId: body.request_id }),
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

const makeSendEmail = (
  client: HttpClient.HttpClient,
  options: MailChannelsOptions
) =>
  Effect.fn("MailChannels.sendEmail")(function* (
    payload: MailChannelsPayload
  ): Effect.fn.Return<MailChannelsBatchResult, TransportError> {
    const endpoint = (
      options.baseUrl ?? "https://api.mailchannels.net"
    ).replace(/\/$/, "")
    const request = pipe(
      HttpClientRequest.post(`${endpoint}/tx/v1/send`),
      HttpClientRequest.setHeader(
        "X-Api-Key",
        Redacted.value(options.apiKey)
      ),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new TransportUnavailable({
            message:
              "MailChannels request failed before a response was received",
            provider: "mailchannels",
            retryable: true,
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* classifyFailure(response, yield* readErrorBody(response))
    }
    const raw = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailChannels returned unreadable JSON",
            provider: "mailchannels",
            status: response.status,
            cause
          })
      )
    )
    const body = yield* Schema.decodeUnknownEffect(MailChannelsSuccess)(
      raw
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "MailChannels returned an unreadable response",
            provider: "mailchannels",
            status: response.status,
            cause
          })
      )
    )
    const entries: Array<MailChannelsResultEntry> = []
    const seen = new Set<number>()
    for (const [position, entry] of (body.results ?? []).entries()) {
      const index = entry.index ?? position
      seen.add(index)
      if (entry.status === "failed") {
        entries.push({
          index,
          failure: new ProviderRejected({
            message: entry.reason ?? "MailChannels rejected the message",
            provider: "mailchannels",
            status: response.status,
            retryable: false,
            cause: entry
          })
        })
      } else if (entry.message_id === undefined) {
        entries.push({
          index,
          failure: new DeliveryUncertain({
            message: "MailChannels returned no message id for this recipient",
            provider: "mailchannels",
            status: response.status,
            cause: entry
          })
        })
      } else {
        entries.push({
          index,
          messageId: providerMessageId(entry.message_id)
        })
      }
    }
    for (let index = 0; index < payload.personalizations.length; index += 1) {
      if (!seen.has(index)) {
        entries.push({
          index,
          failure: new DeliveryUncertain({
            message: "MailChannels returned no result for this message",
            provider: "mailchannels",
            status: response.status,
            cause: raw
          })
        })
      }
    }
    return {
      ...(body.request_id === undefined ? {} : { requestId: body.request_id }),
      entries
    }
  })

const receiptFor = (
  envelope: PreparedEnvelope,
  resolvedDestinationId: ReturnType<typeof destinationId>,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "mailchannels",
  destinationId: resolvedDestinationId,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

const makeTransport = (
  options: MailChannelsOptions,
  sendEmail: MailChannelsClient["sendEmail"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "mailchannels",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const send = Effect.fn("MailChannels.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const payload = yield* payloadFor(envelope.message, options)
    const acceptedAt = yield* DateTime.now
    const result = yield* sendEmail(payload)
    const entry = result.entries.find((candidate) => candidate.index === 0)
    if (entry?.messageId === undefined) {
      return yield* entry?.failure ??
        new DeliveryUncertain({
          message: "MailChannels returned no result for the message",
          provider: "mailchannels"
        })
    }
    return receiptFor(envelope, resolvedDestinationId, entry.messageId, acceptedAt)
  })

  const sendBatchOutcomes: NativeBatchTransport["sendBatch"] = Effect.fn(
    "MailChannels.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const groups = new Map<
      string,
      Array<{
        readonly index: number
        readonly message: PreparedMessage
        readonly shared: MailChannelsShared
      }>
    >()

    for (const [index, envelope] of envelopes.entries()) {
      const result = yield* Effect.result(
        sharedFor(envelope.message, options)
      )
      if (result._tag === "Failure") {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
        continue
      }
      const personalization = yield* Effect.result(
        personalizationFor(envelope.message)
      )
      if (personalization._tag === "Failure") {
        outcomes[index] = {
          _tag: "rejected",
          index,
          error: personalization.failure
        }
        continue
      }
      const signature = JSON.stringify(result.success)
      const group = groups.get(signature)
      if (group === undefined) {
        groups.set(signature, [
          { index, message: envelope.message, shared: result.success }
        ])
      } else {
        group.push({ index, message: envelope.message, shared: result.success })
      }
    }

    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += BATCH_LIMIT) {
        const chunk = group.slice(offset, offset + BATCH_LIMIT)
        const first = chunk[0]!
        const personalizations = yield* Effect.forEach(
          chunk,
          (entry) => personalizationFor(entry.message)
        )
        const payload: MailChannelsPayload = {
          ...first.shared,
          from: personalizations[0]!.from,
          subject: personalizations[0]!.subject,
          personalizations
        }
        const acceptedAt = yield* DateTime.now
        const result = yield* Effect.result(sendEmail(payload))
        if (result._tag === "Failure") {
          for (const entry of chunk) {
            outcomes[entry.index] =
              certaintyOf(result.failure) === "unknown"
                ? { _tag: "uncertain", index: entry.index, error: result.failure }
                : { _tag: "rejected", index: entry.index, error: result.failure }
          }
          continue
        }
        const byIndex = new Map(
          result.success.entries.map((entry) => [entry.index, entry] as const)
        )
        for (const [position, entry] of chunk.entries()) {
          const outcome = byIndex.get(position)
          if (outcome?.messageId === undefined) {
            const error = outcome?.failure ??
              new DeliveryUncertain({
                message: "MailChannels returned no result for this message",
                provider: "mailchannels",
                ...(result.success.requestId === undefined
                  ? {}
                  : { requestId: result.success.requestId })
              })
            outcomes[entry.index] =
              certaintyOf(error) === "unknown"
                ? { _tag: "uncertain", index: entry.index, error }
                : { _tag: "rejected", index: entry.index, error }
          } else {
            outcomes[entry.index] = {
              _tag: "accepted",
              index: entry.index,
              receipt: receiptFor(
                envelopes[entry.index]!,
                resolvedDestinationId,
                outcome.messageId,
                acceptedAt
              )
            }
          }
        }
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
  options: MailChannelsOptions
): Effect.Effect<MailChannelsClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const sendEmail = makeSendEmail(httpClient, options)
    return {
      transport: makeTransport(options, sendEmail),
      sendEmail
    }
  })

export const make = (
  options: MailChannelsOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailChannelsOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailChannelsOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailChannelsOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailChannelsOptions, "apiKey"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Config.Redacted("MAILCHANNELS_API_KEY"), (apiKey) =>
      layerTransport({ ...options, apiKey })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailchannels", account })
