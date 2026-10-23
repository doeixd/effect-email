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
  it.effect("keeps replay keys stable and distinct across stream chunks", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const transport = { ...client.transport, capabilities: { ...client.transport.capabilities, nativeBatch: false } }
      const stream = Email.sendStream(Stream.fromIterable(inputs), {
        chunkSize: 2, providerIdempotencyKey: "stream:42"
      })
      yield* Stream.runDrain(stream).pipe(Effect.provide(Email.layer({ defaultFrom: "sender@example.com", routes: { default: transport } })))
      yield* Stream.runDrain(stream).pipe(Effect.provide(Email.layer({ defaultFrom: "sender@example.com", routes: { default: transport } })))
      const sent = yield* client.inbox.messages
      const keys = sent.map((item) => item.providerIdempotencyKey)
      assert.deepStrictEqual(keys.slice(0, 5), keys.slice(5))
      assert.strictEqual(new Set(keys.slice(0, 5)).size, 5)
    }))

  for (const native of [false, true]) {
    it.live(`limits all ${native ? "native batch" : "single"} sends across chunks to stream concurrency`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        let active = 0
        let peak = 0
        const track = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => { active++; peak = Math.max(peak, active) }),
            () => effect.pipe(Effect.delay("5 millis")),
            () => Effect.sync(() => { active-- })
          )
        const transport = native
          ? {
              ...client.transport,
              capabilities: { ...client.transport.capabilities, maxBatchSize: 1 },
              sendBatch: (envelopes: ReadonlyArray<import("../src/Submission").PreparedEnvelope>) =>
                track(client.transport.sendBatch(envelopes))
            }
          : {
              ...client.transport,
              capabilities: { ...client.transport.capabilities, nativeBatch: false },
              send: (envelope: import("../src/Submission").PreparedEnvelope) => track(client.transport.send(envelope))
            }
        const stream = Email.sendStream(Stream.fromIterable(Array.from({ length: 32 }, () => inputs[0])), {
          concurrency: 4, chunkSize: 8
        })
        const outcomes = yield* Stream.runCollect(stream).pipe(Effect.provide(Email.layer({
          defaultFrom: "billing@example.com", routes: { default: transport }
        })))
        assert.strictEqual(peak, 4)
        assert.strictEqual(active, 0)
        assert.deepStrictEqual(Array.from(outcomes).map((outcome) => outcome.index), Array.from({ length: 32 }, (_, index) => index))
      }))
  }

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
