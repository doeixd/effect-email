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
import type { Result } from "effect/Result"
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

export interface MailgunOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly domain: string
  readonly region?: "us" | "eu"
  readonly baseUrl?: string
  readonly account?: string
}

export interface MailgunSendResult {
  readonly id: ProviderMessageId
}

export interface MailgunClient {
  readonly transport: NativeBatchTransport
  readonly sendForm: (
    form: FormData
  ) => Effect.Effect<MailgunSendResult, TransportError>
}

export class Client extends Context.Service<Client, MailgunClient>()(
  "@effect-email/providers/Mailgun/Client"
) {}

export const MailgunSuccess = Schema.Struct({
  id: Schema.optionalKey(Schema.NonEmptyString),
  message: Schema.optionalKey(Schema.String)
})

export const MailgunErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String)
})

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  maxBatchSize: 1000,
  maxRecipientsPerMessage: 1000,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: true,
  localTemplates: false,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const TAG_LIMIT = 3
const TAG_LENGTH = 128
const HOSTS = {
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net"
} as const

const formatAddress = (address: NormalizedAddress): string =>
  address.name === undefined
    ? address.address
    : `"${address.name.replace(/"/g, '\\"')}" <${address.address}>`

interface PreparedForm {
  readonly fields: ReadonlyArray<readonly [string, string]>
  readonly attachments: ReadonlyArray<PreparedAttachment>
  readonly canBatch: boolean
}

interface PreparedAttachment {
  readonly filename: string
  readonly contentType?: string
  readonly inline: boolean
  readonly bytes: Uint8Array<ArrayBuffer>
}

const attachmentFor = (
  attachment: Attachment
): Effect.Effect<PreparedAttachment, UnsupportedCapability> => {
  if (attachment.source._tag === "url") {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Mailgun does not accept remote attachment URLs",
        provider: "mailgun",
        capability: "remote-attachments"
      })
    )
  }
  if (attachment.source._tag === "path") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Mailgun adapter cannot read attachments from local paths; provide bytes instead",
        provider: "mailgun",
        capability: "attachments"
      })
    )
  }
  const bytes = (() => {
    if (attachment.source.encoding !== "base64") {
      const copy = new Uint8Array(
        new ArrayBuffer(attachment.source.content.length)
      )
      copy.set(attachment.source.content)
      return copy
    }
    const decoded = Base64.decode(
      new TextDecoder().decode(attachment.source.content)
    )
    if (decoded._tag === "Failure") {
      return undefined
    }
    const copy = new Uint8Array(
      new ArrayBuffer(decoded.success.length)
    )
    copy.set(decoded.success)
    return copy
  })()
  if (bytes === undefined) {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Mailgun attachment contains invalid base64 content",
        provider: "mailgun",
        capability: "attachments"
      })
    )
  }
  return Effect.succeed({
    filename: attachment.contentId ?? attachment.filename,
    ...(attachment.contentType === undefined
      ? {}
      : { contentType: attachment.contentType }),
    inline:
      attachment.contentId !== undefined ||
      attachment.disposition === "inline",
    bytes
  })
}

const formFor = (
  message: PreparedMessage
): Effect.Effect<PreparedForm, TransportError> => {
  if (message.tags.length > TAG_LIMIT) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailgun accepts at most ${TAG_LIMIT} tags per message, got ${message.tags.length}`,
        provider: "mailgun",
        capability: "tags"
      })
    )
  }
  const longTag = message.tags.find((tag) => tag.length > TAG_LENGTH)
  if (longTag !== undefined) {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailgun tags may be at most ${TAG_LENGTH} characters`,
        provider: "mailgun",
        capability: "tags"
      })
    )
  }

  const content = message.content
  if (content._tag !== "rendered" && content._tag !== "provider-template") {
    return Effect.fail(
      new UnsupportedCapability({
        message: `Mailgun adapter does not support ${content._tag} content`,
        provider: "mailgun",
        capability: content._tag === "raw" ? "raw-mime" : "local-templates"
      })
    )
  }

  return Effect.forEach(message.attachments, attachmentFor).pipe(
    Effect.map((attachments) => {
      const fields: Array<readonly [string, string]> = [
        ["from", formatAddress(message.from)],
        ["subject", message.subject]
      ]
      if (content._tag === "rendered") {
        if (content.text !== undefined) fields.push(["text", content.text])
        if (content.html !== undefined) fields.push(["html", content.html])
      } else {
        fields.push(["template", content.id])
        if (content.variables !== undefined) {
          fields.push(["t:variables", JSON.stringify(content.variables)])
        }
      }
      if (message.replyTo.length > 0) {
        fields.push([
          "h:Reply-To",
          message.replyTo.map(formatAddress).join(", ")
        ])
      }
      for (const [name, value] of message.headers) {
        fields.push([`h:${name}`, value])
      }
      for (const tag of message.tags) {
        fields.push(["o:tag", tag])
      }
      return {
        fields,
        attachments,
        canBatch:
          message.to.length === 1 &&
          message.cc.length === 0 &&
          message.bcc.length === 0 &&
          attachments.length === 0
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
): Effect.Effect<typeof MailgunErrorBody.Type & { readonly text?: string }> =>
  response.json.pipe(
    Effect.flatMap((body) =>
      typeof body === "string"
        ? Effect.succeed({ message: body })
        : Schema.decodeUnknownEffect(MailgunErrorBody)(body).pipe(
            Effect.orElseSucceed(() => ({}))
          )
    ),
    Effect.orElseSucceed(() => ({}))
  )

const classifyFailure = (
  response: HttpClientResponse.HttpClientResponse,
  body: typeof MailgunErrorBody.Type
): TransportError => {
  const message =
    body.message ?? `Mailgun request failed with status ${response.status}`
  const retryAfterMillis = parseRetryAfter(
    headerValue(response, "retry-after")
  )
  const common = {
    message,
    provider: "mailgun",
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

const makeSendForm = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  domain: string,
  baseUrl: string
) =>
  Effect.fn("Mailgun.sendForm")(function* (
    form: FormData
  ): Effect.fn.Return<MailgunSendResult, TransportError> {
    const authorization = `Basic ${Base64.encode(
      new TextEncoder().encode(`api:${Redacted.value(apiKey)}`)
    )}`
    const request = pipe(
      HttpClientRequest.post(
        `${baseUrl}/v3/${encodeURIComponent(domain)}/messages`
      ),
      HttpClientRequest.setHeader("Authorization", authorization),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyFormData(form)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryUncertain({
            message: "Mailgun request failed before a response was received; outcome is unknown",
            provider: "mailgun",
            cause
          })
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
            message: "Mailgun returned an unreadable success response",
            provider: "mailgun",
            status: response.status,
            cause
          })
      )
    )
    const decoded = yield* Schema.decodeUnknownEffect(MailgunSuccess)(
      body
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MalformedProviderResponse({
            message: "Mailgun success response did not contain a message id",
            provider: "mailgun",
            status: response.status,
            cause
          })
      )
    )
    if (decoded.id === undefined) {
      return yield* new MalformedProviderResponse({
        message: "Mailgun success response did not contain a message id",
        provider: "mailgun",
        status: response.status,
        cause: body
      })
    }
    return { id: providerMessageId(decoded.id.replace(/^<|>$/g, "")) }
  })

interface Entry {
  readonly index: number
  readonly message: PreparedMessage
  readonly form: PreparedForm
}

const blobFor = (attachment: PreparedAttachment): Blob =>
  new Blob([attachment.bytes], {
    type: attachment.contentType ?? "application/octet-stream"
  })

const deliver = (
  sendForm: MailgunClient["sendForm"],
  entries: ReadonlyArray<Entry>
): Effect.Effect<
  {
    readonly acceptedAt: DateTime.Utc
    readonly id: ProviderMessageId
  },
  TransportError
> =>
  Effect.gen(function* () {
    const first = entries[0]!
    const form = new FormData()
    for (const [name, value] of first.form.fields) {
      form.append(name, value)
    }
    for (const entry of entries) {
      for (const address of entry.message.to) {
        form.append("to", formatAddress(address))
      }
    }
    for (const address of first.message.cc) {
      form.append("cc", formatAddress(address))
    }
    for (const address of first.message.bcc) {
      form.append("bcc", formatAddress(address))
    }
    for (const attachment of first.form.attachments) {
      form.append(
        attachment.inline ? "inline" : "attachment",
        blobFor(attachment),
        attachment.filename
      )
    }
    if (entries.length > 1) {
      const variables: Record<string, { readonly email: string; readonly name?: string }> = {}
      for (const entry of entries) {
        for (const address of entry.message.to) {
          variables[address.address] = {
            email: address.address,
            ...(address.name === undefined ? {} : { name: address.name })
          }
        }
      }
      form.append("recipient-variables", JSON.stringify(variables))
    }
    const acceptedAt = yield* DateTime.now
    const result = yield* sendForm(form)
    return { acceptedAt, id: result.id }
  })

const makeTransport = (
  options: MailgunOptions,
  sendForm: MailgunClient["sendForm"]
): NativeBatchTransport => {
  const destination = makeDestination({
    provider: "mailgun",
    account: options.account ?? "default"
  })
  const resolvedDestinationId = destinationId(destination)

  const receiptFor = (
    envelope: PreparedEnvelope,
    id: ProviderMessageId,
    acceptedAt: DateTime.Utc
  ): SubmissionReceipt => ({
    deliveryId: envelope.deliveryId,
    provider: "mailgun",
    destinationId: resolvedDestinationId,
    providerMessageId: id,
    acceptedAt,
    route: envelope.route
  })

  const send = Effect.fn("Mailgun.transport.send")(function* (
    envelope: PreparedEnvelope
  ): Effect.fn.Return<SubmissionReceipt, TransportError> {
    const form = yield* formFor(envelope.message)
    const result = yield* deliver(sendForm, [
      { index: 0, message: envelope.message, form }
    ])
    return receiptFor(envelope, result.id, result.acceptedAt)
  })

  const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
    "Mailgun.transport.sendBatch"
  )(function* (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
    const outcomes: Array<MessageOutcome> = Array.from({
      length: envelopes.length
    })
    const groups = new Map<string, Array<Entry>>()
    const solo: Array<Entry> = []

    for (const [index, envelope] of envelopes.entries()) {
      const result = yield* Effect.result(formFor(envelope.message))
      if (result._tag === "Failure") {
        outcomes[index] =
          certaintyOf(result.failure) === "unknown"
            ? { _tag: "uncertain", index, error: result.failure }
            : { _tag: "rejected", index, error: result.failure }
        continue
      }
      const entry: Entry = {
        index,
        message: envelope.message,
        form: result.success
      }
      if (!result.success.canBatch) {
        solo.push(entry)
        continue
      }
      const signature = JSON.stringify(result.success.fields)
      const group = groups.get(signature)
      if (group === undefined) {
        groups.set(signature, [entry])
      } else {
        group.push(entry)
      }
    }

    const assign = (
      entries: ReadonlyArray<Entry>,
      result: Result<
        {
          readonly acceptedAt: DateTime.Utc
          readonly id: ProviderMessageId
        },
        TransportError
      >
    ) => {
      for (const entry of entries) {
        if (result._tag === "Failure") {
          outcomes[entry.index] =
            certaintyOf(result.failure) === "unknown"
              ? { _tag: "uncertain", index: entry.index, error: result.failure }
              : { _tag: "rejected", index: entry.index, error: result.failure }
        } else {
          outcomes[entry.index] = {
            _tag: "accepted",
            index: entry.index,
            receipt: receiptFor(
              envelopes[entry.index]!,
              result.success.id,
              result.success.acceptedAt
            )
          }
        }
      }
    }

    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += 1000) {
        const run = group.slice(offset, offset + 1000)
        assign(run, yield* Effect.result(deliver(sendForm, run)))
      }
    }
    for (const entry of solo) {
      assign([entry], yield* Effect.result(deliver(sendForm, [entry])))
    }

    return outcomes
  })

  return {
    destination,
    capabilities: capabilities as NativeBatchTransport["capabilities"],
    send,
    sendBatch
  }
}

export const makeClient = (
  options: MailgunOptions
): Effect.Effect<MailgunClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl =
      options.baseUrl ??
      HOSTS[options.region ?? "us"]
    const sendForm = makeSendForm(
      httpClient,
      options.apiKey,
      options.domain,
      baseUrl.replace(/\/$/, "")
    )
    return {
      transport: makeTransport(options, sendForm),
      sendForm
    }
  })

export const make = (
  options: MailgunOptions
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailgunOptions
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailgunOptions
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MailgunOptions
): Layer.Layer<EmailTransport | Client, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const layerConfig = (
  options: Omit<MailgunOptions, "apiKey" | "domain"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        apiKey: Config.Redacted("MAILGUN_API_KEY"),
        domain: Config.String("MAILGUN_DOMAIN")
      }),
      ({ apiKey, domain }) =>
        layerTransport({ ...options, apiKey, domain })
    )
  )

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mailgun", account })

