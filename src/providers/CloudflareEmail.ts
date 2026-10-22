import { DateTime, Effect, Layer } from "effect"
import type { Destination } from "../Ids"
import { destinationId, makeDestination } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  DeliveryUncertain,
  UnsupportedCapability
} from "../EmailError"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import type { PreparedEnvelope, SubmissionReceipt } from "../Submission"
import { buildMime } from "../smtp/Mime"

export interface CloudflareEmailBinding {
  readonly send: (message: unknown) => Promise<void> | void
}

export type CloudflareEmailMessageCtor = new (
  from: string,
  to: string,
  raw: string
) => unknown

export interface CloudflareEmailOptions {
  readonly binding: CloudflareEmailBinding
  readonly EmailMessage?: CloudflareEmailMessageCtor
  readonly account?: string
}

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  attachments: true,
  remoteAttachments: false,
  rawMime: true,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const resolveConstructor = (
  options: CloudflareEmailOptions
): CloudflareEmailMessageCtor => {
  const ctor =
    options.EmailMessage ??
    (globalThis as {
      EmailMessage?: CloudflareEmailMessageCtor
    }).EmailMessage
  if (ctor === undefined) {
    throw new Error(
      'cloudflare-email requires an EmailMessage constructor from "cloudflare:email"'
    )
  }
  return ctor
}

export const make = (
  options: CloudflareEmailOptions
): Effect.Effect<Transport> =>
  Effect.sync(() => {
    const Ctor = resolveConstructor(options)
    const destination: Destination = makeDestination({
      provider: "cloudflare-email",
      account: options.account ?? "default"
    })
    const resolvedDestinationId = destinationId(destination)

    const send = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.gen(function* () {
        if (
          envelope.message.content._tag === "raw" &&
          envelope.message.attachments.length > 0
        ) {
          return yield* new UnsupportedCapability({
            message:
              "the Cloudflare Email Routing binding cannot attach files to raw MIME",
            provider: "cloudflare-email",
            capability: "attachments"
          })
        }
        if (
          envelope.message.to.length !== 1 ||
          envelope.message.cc.length > 0 ||
          envelope.message.bcc.length > 0
        ) {
          return yield* new UnsupportedCapability({
            message:
              "the Cloudflare Email Routing binding accepts exactly one recipient",
            provider: "cloudflare-email",
            capability: "recipients"
          })
        }
        const mime = yield* buildMime(envelope.message)
        const raw = new TextDecoder().decode(mime)
        const recipient = envelope.message.to[0]!
        yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              options.binding.send(
                new Ctor(
                  envelope.message.from.address,
                  recipient.address,
                  raw
                )
              )
            ),
          catch: (cause) =>
            new DeliveryUncertain({
              message: "Cloudflare Email binding failed",
              provider: "cloudflare-email",
              cause
            })
        })
        const acceptedAt = yield* DateTime.now
        return {
          deliveryId: envelope.deliveryId,
          provider: "cloudflare-email",
          destinationId: resolvedDestinationId,
          acceptedAt,
          route: envelope.route
        }
      })

    return { destination, capabilities, send }
  })

export const layer = (
  options: CloudflareEmailOptions
): Layer.Layer<EmailTransport> =>
  Layer.effect(EmailTransport, make(options))
