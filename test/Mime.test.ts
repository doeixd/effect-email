import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { deliveryId } from "../src/Ids"
import { prepare } from "../src/Message"
import { buildMime } from "../src/smtp/Mime"

const date = new Date("2026-01-01T00:00:00.000Z")

const baseMessage = {
  from: { address: "Sender <sender@example.com>" },
  to: "user@example.com",
  cc: "copy@example.com",
  bcc: "hidden@example.com",
  replyTo: "reply@example.com",
  subject: "Hello \u2713",
  text: "Plain body",
  html: "<p>HTML body</p>",
  headers: [["X-Campaign", "welcome"]] as Array<[string, string]>,
  deliveryId: deliveryId("dlv_mime_1")
} as const

describe("SMTP MIME builder", () => {
  it.effect("escapes legacy delivery ids and rejects message-id header injection", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare(baseMessage)
      const malicious = "safe>\r\nBcc: injected@example.com"
      const mime = new TextDecoder().decode(yield* buildMime({
        ...prepared, deliveryId: malicious as import("../src/Ids").DeliveryId
      }))
      assert.notInclude(mime, "\r\nBcc:")
      assert.include(mime, encodeURIComponent(malicious))
      const custom = yield* Effect.result(buildMime(prepared, { messageId: malicious }))
      assert.strictEqual(custom._tag === "Failure" && custom.failure._tag, "UnsupportedCapability")
    }))

  it.effect("builds headers and multipart bodies", () =>
    Effect.gen(function* () {
      const message = yield* prepare(baseMessage)
      const bytes = yield* buildMime(message, { date })
      const mime = new TextDecoder().decode(bytes)

      assert.include(mime, "From: Sender <sender@example.com>")
      assert.include(mime, "To: user@example.com")
      assert.include(mime, "Cc: copy@example.com")
      assert.include(mime, "Reply-To: reply@example.com")
      assert.notInclude(mime, "Bcc:")
      assert.include(mime, "x-campaign: welcome")
      assert.match(mime, /Subject: =\?UTF-8\?B\?/)
      assert.include(mime, "Date: Thu, 01 Jan 2026 00:00:00 GMT")
      assert.include(
        mime,
        "Message-ID: <dlv_mime_1@example.com>"
      )
      assert.include(mime, "multipart/alternative")
      assert.include(mime, "text/plain; charset=UTF-8")
      assert.include(mime, "text/html; charset=UTF-8")
    }))

  it.effect("wraps attachments in multipart/mixed", () =>
    Effect.gen(function* () {
      const message = yield* prepare({
        ...baseMessage,
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
      })
      const mime = new TextDecoder().decode(
        yield* buildMime(message, { date })
      )

      assert.include(mime, "multipart/mixed")
      assert.include(
        mime,
        'Content-Disposition: attachment; filename="note.txt"'
      )
      assert.include(mime, "aGVsbG8=")
    }))

  it.effect("returns raw MIME unchanged", () =>
    Effect.gen(function* () {
      const raw = new TextEncoder().encode(
        "Subject: raw\r\n\r\nBody\r\n"
      )
      const message = yield* prepare({
        from: "sender@example.com",
        to: "user@example.com",
        subject: "ignored",
        rawMime: raw,
        deliveryId: deliveryId("dlv_mime_raw")
      })
      const built = yield* buildMime(message)

      assert.deepStrictEqual([...built], [...raw])
    }))

  it.effect("rejects path attachments", () =>
    Effect.gen(function* () {
      const message = yield* prepare({
        ...baseMessage,
        attachments: [
          {
            filename: "file.txt",
            source: { _tag: "path", path: "file.txt" }
          }
        ]
      })
      const result = yield* Effect.result(buildMime(message))

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "UnsupportedCapability"
      )
    }))
})
