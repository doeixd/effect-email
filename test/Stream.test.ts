import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Email from "../src/Email"
import * as EmailTransport from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"

const inputs = [
  { to: "one@example.com", subject: "One", text: "One" },
  { to: "two@example.com", subject: "Two", text: "Two" },
  { to: "three@example.com", subject: "Three", text: "Three" },
  { to: "four@example.com", subject: "Four", text: "Four" },
  { to: "five@example.com", subject: "Five", text: "Five" }
] as const

describe("Email.sendStream", () => {
  it.effect("keeps ordered, globally indexed outcomes across bounded chunks", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const batchSizes: Array<number> = []
      const transport: EmailTransport.NativeBatchTransport = {
        destination: client.transport.destination,
        capabilities: client.transport.capabilities,
        send: client.transport.send,
        sendBatch: (envelopes) =>
          Effect.gen(function* () {
            batchSizes.push(envelopes.length)
            return yield* client.transport.sendBatch(envelopes)
          })
      }
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const outcomes = yield* Stream.runCollect(
        Email.sendStream(Stream.fromIterable(inputs), {
          chunkSize: 2,
          concurrency: 1
        })
      ).pipe(Effect.provide(layer))

      assert.deepStrictEqual(batchSizes, [2, 2, 1])
      assert.deepStrictEqual(
        Array.from(outcomes).map((outcome) => outcome.index),
        [0, 1, 2, 3, 4]
      )
      assert.deepStrictEqual(
        Array.from(outcomes).map((outcome) => outcome._tag),
        ["accepted", "accepted", "accepted", "accepted", "accepted"]
      )
      assert.strictEqual((yield* client.inbox.messages).length, 5)
    }))

  it.effect("rejects a non-positive chunk size", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport }
      })

      const error = yield* Stream.runDrain(
        Email.sendStream(Stream.fromIterable(inputs), { chunkSize: 0 })
      ).pipe(Effect.provide(layer), Effect.flip)

      assert.strictEqual(error._tag, "BatchExecutionError")
    }))
})
