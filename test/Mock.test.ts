import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Email from "../src/Email"
import type { Transport } from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"

const emailLayerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("Mock", () => {
  it.effect("records accepted messages and exposes them in the inbox", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()

      const receipt = yield* Email.send({
        to: "Customer@Example.com",
        subject: "Your receipt",
        text: "Receipt body"
      }).pipe(Effect.provide(emailLayerFor(client.transport)))

      const last = yield* client.inbox.last
      const found = yield* client.inbox.find("customer@example.com")

      assert.strictEqual(receipt.provider, "mock")
      assert.isTrue(receipt.providerMessageId?.startsWith("mock_"))
      assert.isTrue(Option.isSome(last))
      assert.strictEqual(
        Option.isSome(last) && last.value.message.subject,
        "Your receipt"
      )
      assert.strictEqual(found.length, 1)
    }))

  it.effect("reports positional outcomes for a partial batch", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        failWhen: (message) =>
          message.to.some(
            (recipient) => recipient.address === "fail@example.com"
          )
      })

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "One", text: "One" },
        { to: "fail@example.com", subject: "Two", text: "Two" },
        { to: "three@example.com", subject: "Three", text: "Three" }
      ]).pipe(Effect.provide(emailLayerFor(client.transport)))
      const messages = yield* client.inbox.messages

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "rejected", "accepted"]
      )
      assert.strictEqual(messages.length, 2)
    }))

  it.effect("maps configured failure codes to transport errors", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        fail: { code: "RATE_LIMIT", message: "slow down" }
      })

      const result = yield* Effect.result(
        Email.send({
          to: "one@example.com",
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(client.transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "RateLimited"
      )
    }))

  it.effect("can fail every send with a network error", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        fail: { code: "NETWORK" }
      })

      const result = yield* Effect.result(
        Email.send({
          to: "one@example.com",
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(client.transport)))
      )
      const messages = yield* client.inbox.messages

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "TransportUnavailable"
      )
      assert.strictEqual(messages.length, 0)
    }))
})
