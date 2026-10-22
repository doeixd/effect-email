import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Email from "../src/Email"
import type { Transport } from "../src/EmailTransport"
import { providerMessageId } from "../src/Ids"
import * as CloudflareEmail from "../src/providers/CloudflareEmail"
import * as CloudflareEmailService from "../src/providers/CloudflareEmailService"

const layerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("Cloudflare Email bindings", () => {
  it.effect("sends raw MIME through the legacy binding", () =>
    Effect.gen(function* () {
      class Message {
        constructor(
          readonly from: string,
          readonly to: string,
          readonly raw: string
        ) {}
      }
      let captured: Message | undefined
      const transport = yield* CloudflareEmail.make({
        EmailMessage: Message,
        binding: {
          send: (message) => {
            captured = message as Message
          }
        }
      })

      const receipt = yield* Email.send({
        to: "user@example.com",
        subject: "Legacy",
        text: "Legacy body"
      }).pipe(Effect.provide(layerFor(transport)))

      assert.isDefined(captured)
      assert.strictEqual(captured!.from, "billing@example.com")
      assert.strictEqual(captured!.to, "user@example.com")
      assert.include(captured!.raw, "Subject: Legacy")
      assert.strictEqual(receipt.provider, "cloudflare-email")
    }))

  it.effect("rejects multiple recipients for the legacy binding", () =>
    Effect.gen(function* () {
      class Message {
        constructor(
          readonly from: string,
          readonly to: string,
          readonly raw: string
        ) {}
      }
      const transport = yield* CloudflareEmail.make({
        EmailMessage: Message,
        binding: { send: () => undefined }
      })

      const result = yield* Effect.result(
        Email.send({
          to: ["one@example.com", "two@example.com"],
          subject: "Legacy",
          text: "Body"
        }).pipe(Effect.provide(layerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "UnsupportedCapability"
      )
    }))

  it.effect("sends structured content through the Email Service binding", () =>
    Effect.gen(function* () {
      let captured: CloudflareEmailService.CloudflareEmailServiceMessage | undefined
      const transport = yield* CloudflareEmailService.make({
        binding: {
          send: (message) => {
            captured = message
            return { messageId: "cf_1" }
          }
        }
      })

      const receipt = yield* Email.send({
        to: "user@example.com",
        cc: "cc@example.com",
        subject: "Structured",
        text: "Body",
        html: "<p>Body</p>",
        headers: [["X-Campaign", "welcome"]],
        attachments: [
          {
            filename: "note.txt",
            contentType: "text/plain",
            source: {
              _tag: "content",
              content: new TextEncoder().encode("hello"),
              encoding: "utf8"
            }
          }
        ]
      }).pipe(Effect.provide(layerFor(transport)))

      assert.isDefined(captured)
      assert.strictEqual(captured!.subject, "Structured")
      assert.strictEqual(captured!.text, "Body")
      assert.deepStrictEqual(captured!.cc, [
        { email: "cc@example.com" }
      ])
      assert.strictEqual(captured!.headers?.["x-campaign"], "welcome")
      assert.strictEqual(
        captured!.attachments?.[0]?.content,
        "aGVsbG8="
      )
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("cf_1")
      )
    }))
})
