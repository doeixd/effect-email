import { assert, describe, it } from "@effect/vitest"
import { Effect, pipe } from "effect"
import { deliveryId } from "../src/Ids"
import * as Message from "../src/Message"

describe("Message", () => {
  it.effect("normalizes mailboxes deterministically", () =>
    Effect.sync(() => {
      const draft = Message.make({
        to: [
          " Jane Doe <Jane@Example.COM> ",
          { address: "JANE@example.com", name: "Duplicate" }
        ],
        subject: "Your receipt",
        text: "Hello"
      })

      assert.strictEqual(draft.to.length, 1)
      assert.strictEqual(draft.to[0]?.address, "Jane@example.com")
      assert.strictEqual(draft.to[0]?.name, "Jane Doe")
      assert.strictEqual(draft.to[0]?.domain, "example.com")
      assert.strictEqual(draft.to[0]?.local, "Jane")
    }))

  it.effect("does not mutate caller-owned input", () =>
    Effect.sync(() => {
      const to = Object.freeze([Object.freeze({ address: "a@example.com" })])
      const headers = Object.freeze([
        Object.freeze(["X-Request-Id", "abc"] as const)
      ])
      const input = Object.freeze({
        to,
        subject: "Hi",
        text: "Body",
        headers
      })

      const draft = Message.make(input)

      assert.isFalse(draft.to === (input.to as unknown))
      assert.isFalse(draft.headers === (input.headers as unknown))
      assert.deepStrictEqual(input.to, [{ address: "a@example.com" }])
      assert.deepStrictEqual(input.headers, [["X-Request-Id", "abc"]])
    }))

  it.effect("rejects header injection", () =>
    Effect.sync(() => {
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi",
          text: "Body",
          headers: [["X-Test", "ok\r\nBcc: victim@example.com"]]
        })
      )
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi\r\nBcc: victim@example.com",
          text: "Body"
        })
      )
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi",
          text: "Body",
          headers: [["Bcc", "victim@example.com"]]
        })
      )
    }))

  it.effect("requires exactly one content form", () =>
    Effect.sync(() => {
      assert.throws(() =>
        Message.make({ to: "a@example.com", subject: "Hi" })
      )
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi",
          text: "Body",
          template: { id: "receipt" }
        })
      )

      const both = Message.make({
        to: "a@example.com",
        subject: "Hi",
        text: "Body",
        html: "<p>Body</p>"
      })
      assert.strictEqual(both.content._tag, "rendered")
    }))

  it.effect("rejects tags that are unsafe as header names", () =>
    Effect.sync(() => {
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi",
          text: "Body",
          tags: ["bad tag"]
        })
      )
      assert.throws(() =>
        Message.make({
          to: "a@example.com",
          subject: "Hi",
          text: "Body",
          tags: ["bad\r\nBcc: victim@example.com"]
        })
      )
    }))

  it.effect("supports pure composition", () =>
    Effect.sync(() => {
      const input = pipe(
        Message.make({
          to: "customer@example.com",
          subject: "Your receipt",
          text: "Receipt"
        }),
        Message.setFrom("billing@example.com"),
        Message.addTag("transactional"),
        Message.addTag("transactional"),
        Message.withDeliveryId(deliveryId("receipt:123"))
      )

      assert.strictEqual(input.from?.address, "billing@example.com")
      assert.deepStrictEqual(input.tags, ["transactional"])
      assert.strictEqual(input.deliveryId, "receipt:123")
    }))

  it.effect("reports invalid addresses as InvalidMessage", () =>
    Effect.gen(function* () {
      const error = yield* Message.prepare(
        { to: "not-an-address", subject: "Hi", text: "Body" },
        { from: "from@example.com" }
      ).pipe(Effect.flip)

      assert.strictEqual(error._tag, "InvalidMessage")
    }))

  it.effect("requires a sender", () =>
    Effect.gen(function* () {
      const error = yield* Message.prepare({
        to: "a@example.com",
        subject: "Hi",
        text: "Body"
      }).pipe(Effect.flip)

      assert.strictEqual(error._tag, "InvalidMessage")
    }))
})
