import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

const providers = [
  "AhaSend",
  "AzureCommunication",
  "Brevo",
  "CloudflareEmail",
  "CloudflareEmailRest",
  "CloudflareEmailService",
  "Http",
  "Loops",
  "Mailbreeze",
  "MailChannels",
  "Mailcrab",
  "MailerSend",
  "Mailgun",
  "Mailjet",
  "Mailpit",
  "Mailtrap",
  "Mock",
  "Postmark",
  "Resend",
  "Scaleway",
  "SendGrid",
  "Ses",
  "Smtp",
  "Smtp2go",
  "Zeptomail"
] as const

describe("Provider surface", () => {
  it.effect("exports the canonical constructors", () =>
    Effect.gen(function* () {
      for (const name of providers) {
        const module = (yield* Effect.promise(
          () => import(`../src/providers/${name}.ts`)
        )) as Record<string, unknown>

        assert.strictEqual(
          typeof module.make,
          "function",
          `${name} must export make`
        )
        assert.strictEqual(
          typeof module.layer,
          "function",
          `${name} must export layer`
        )
        if (name !== "Http") {
          assert.isObject(
            module.capabilities,
            `${name} must export capabilities`
          )
        }
        if (module.Client !== undefined) {
          assert.strictEqual(
            typeof module.makeClient,
            "function",
            `${name} must export makeClient when it exports Client`
          )
          assert.strictEqual(
            typeof module.layerClient,
            "function",
            `${name} must export layerClient when it exports Client`
          )
          assert.strictEqual(
            typeof module.layerTransport,
            "function",
            `${name} must export layerTransport when it exports Client`
          )
        }
      }
    }))
})
