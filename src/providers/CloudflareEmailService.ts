import { DateTime, Effect, Layer } from "effect"
import { Base64 } from "effect/encoding"
import type { Destination } from "../Ids"
import { destinationId, makeDestination, providerMessageId } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  DeliveryUncertain,
  ProviderRejected,
  RateLimited,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { NormalizedAddress, PreparedMessage } from "../Message"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import type { PreparedEnvelope, SubmissionReceipt } from "../Submission"

export interface CloudflareEmailServiceAttachment {
  readonly content: string | Uint8Array
  readonly filename: string
  readonly type: string
  readonly disposition: "attachment" | "inline"
  readonly contentId?: string
}

export interface CloudflareEmailServiceMessage {
  readonly from: {
    readonly email: string
    readonly name?: string
  }
  readonly to: ReadonlyArray<{
    readonly email: string
    readonly name?: string
  }>
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly cc?: ReadonlyArray<{
    readonly email: string
    readonly name?: string
  }>
  readonly bcc?: ReadonlyArray<{
    readonly email: string
    readonly name?: string
  }>
  readonly replyTo?: {
    readonly email: string
    readonly name?: string
  }
  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: ReadonlyArray<CloudflareEmailServiceAttachment>
}

export interface CloudflareEmailSendResult {
  readonly messageId?: string
}

export interface CloudflareEmailServiceBinding {
  readonly send: (
    message: CloudflareEmailServiceMessage
  ) => Promise<CloudflareEmailSendResult | void> | CloudflareEmailSendResult | void
}

export interface CloudflareEmailServiceOptions {
  readonly binding: CloudflareEmailServiceBinding
  readonly account?: string
}

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
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
})

const RECIPIENT_LIMIT = 50
const ATTACHMENT_LIMIT = 32

const address = (value: NormalizedAddress) => ({
  email: value.address,
  ...(value.name === undefined ? {} : { name: value.name })
})

const attachment = (
  value: PreparedMessage["attachments"][number]
): Effect.Effect<CloudflareEmailServiceAttachment, UnsupportedCapability> => {
  switch (value.source._tag) {
    case "path":
      return Effect.fail(
        new UnsupportedCapability({
          message:
            "Cloudflare Email Service cannot read attachments from local paths",
          provider: "cloudflare-email-service",
          capability: "attachments"
        })
      )
    case "url":
      return Effect.fail(
        new UnsupportedCapability({
          message:
            "Cloudflare Email Service does not fetch remote attachment URLs",
          provider: "cloudflare-email-service",
          capability: "remote-attachments"
        })
      )
    case "content":
      return Effect.succeed({
        content:
          value.source.encoding === "base64"
            ? new TextDecoder().decode(value.source.content)
            : Base64.encode(value.source.content),
        filename: value.filename,
        type: value.contentType ?? "application/octet-stream",
        disposition:
          value.disposition ??
          (value.contentId === undefined ? "attachment" : "inline"),
        ...(value.contentId === undefined
          ? {}
          : { contentId: value.contentId })
      })
  }
}

const payloadFor = (
  message: PreparedMessage
): Effect.Effect<
  CloudflareEmailServiceMessage,
  TransportError
> => {
  if (message.content._tag !== "rendered") {
    return Effect.fail(
      new UnsupportedCapability({
        message:
          "Cloudflare Email Service requires rendered text or HTML",
        provider: "cloudflare-email-service",
        capability: "content"
      })
    )
  }
  if (message.replyTo.length > 1) {
    return Effect.fail(
      new UnsupportedCapability({
        message: "Cloudflare Email Service accepts a single reply-to address",
        provider: "cloudflare-email-service",
        capability: "reply-to"
      })
    )
  }
  const content = message.content
  return Effect.map(
    Effect.forEach(message.attachments, attachment),
    (attachments) => ({
      from: address(message.from),
      to: message.to.map(address),
      subject: message.subject,
      ...(content.text === undefined ? {} : { text: content.text }),
      ...(content.html === undefined ? {} : { html: content.html }),
      ...(message.cc.length === 0
        ? {}
        : { cc: message.cc.map(address) }),
      ...(message.bcc.length === 0
        ? {}
        : { bcc: message.bcc.map(address) }),
      ...(message.replyTo[0] === undefined
        ? {}
        : { replyTo: address(message.replyTo[0]) }),
      ...(message.headers.length === 0
        ? {}
        : { headers: Object.fromEntries(message.headers) }),
      ...(attachments.length === 0 ? {} : { attachments })
    })
  )
}

const failure = (cause: unknown): TransportError => {
  const code =
    cause instanceof Error && "code" in cause
      ? String((cause as { code: unknown }).code)
      : ""
  const message =
    cause instanceof Error
      ? cause.message
      : "Cloudflare Email Service binding failed"
  const common = { message, provider: "cloudflare-email-service", cause }
  if (
    code === "E_SENDER_NOT_VERIFIED" ||
    code === "E_SENDER_DOMAIN_NOT_AVAILABLE" ||
    code === "E_RECIPIENT_NOT_ALLOWED"
  ) {
    return new AuthenticationFailed(common)
  }
  if (
    code === "E_RATE_LIMIT_EXCEEDED" ||
    code === "E_DAILY_LIMIT_EXCEEDED"
  ) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (code === "E_DELIVERY_FAILED") {
    return new DeliveryUncertain(common)
  }
  if (code === "E_INTERNAL_SERVER_ERROR") {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

export const make = (
  options: CloudflareEmailServiceOptions
): Effect.Effect<Transport> =>
  Effect.sync(() => {
    const destination: Destination = makeDestination({
      provider: "cloudflare-email-service",
      account: options.account ?? "default"
    })
    const resolvedDestinationId = destinationId(destination)

    const send = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.gen(function* () {
        const recipients =
          envelope.message.to.length +
          envelope.message.cc.length +
          envelope.message.bcc.length
        if (recipients > RECIPIENT_LIMIT) {
          return yield* new UnsupportedCapability({
            message: `${recipients} recipients exceed the Cloudflare limit of ${RECIPIENT_LIMIT}`,
            provider: "cloudflare-email-service",
            capability: "recipients"
          })
        }
        if (envelope.message.attachments.length > ATTACHMENT_LIMIT) {
          return yield* new UnsupportedCapability({
            message: `${envelope.message.attachments.length} attachments exceed the Cloudflare limit of ${ATTACHMENT_LIMIT}`,
            provider: "cloudflare-email-service",
            capability: "attachments"
          })
        }
        const payload = yield* payloadFor(envelope.message)
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(options.binding.send(payload)),
          catch: failure
        })
        const acceptedAt = yield* DateTime.now
        return {
          deliveryId: envelope.deliveryId,
          provider: "cloudflare-email-service",
          destinationId: resolvedDestinationId,
          providerMessageId: providerMessageId(
            result?.messageId ?? String(envelope.deliveryId)
          ),
          acceptedAt,
          route: envelope.route
        }
      })

    return { destination, capabilities, send }
  })

export const layer = (
  options: CloudflareEmailServiceOptions
): Layer.Layer<EmailTransport> =>
  Layer.effect(EmailTransport, make(options))
