import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as Email from "../src/Email"
import * as Policy from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"
import { TransportUnavailable } from "../src/EmailError"
import type { MessageOutcome, PreparedEnvelope } from "../src/Submission"

const messages = ["first", "second", "third"].map((subject) => ({
  to: `${subject}@example.com`, subject, text: "Body"
}))
const layer = (transport: Policy.Transport) => Email.layer({
  defaultFrom: "sender@example.com", routes: { default: transport }
})
const unavailable = () => TransportUnavailable.new({ message: "not submitted", retryable: true })

describe("Policy composition", () => {
  for (const partialRetry of [false, true]) {
    it.effect(`preserves accepted chunks through later failures (partial retry: ${partialRetry})`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        let calls = 0
        const base = {
          ...client.transport,
          capabilities: { ...client.transport.capabilities, partialBatchRetry: partialRetry },
          sendBatch: (envelopes: ReadonlyArray<PreparedEnvelope>) => Effect.suspend(() => {
            calls++
            return calls === 2 ? Effect.fail(unavailable()) : client.transport.sendBatch(envelopes)
          })
        }
        const limited = yield* Policy.withRateLimit({ messages: { limit: 1, intervalMillis: 1 } })(base)
        const retried = Policy.withRetry({ maxAttempts: 2, baseDelayMillis: 0 })(limited)
        const fiber = yield* Email.sendBatch(messages.slice(0, 2)).pipe(Effect.provide(layer(retried)), Effect.forkChild)
        yield* TestClock.adjust(20)
        const results = yield* Fiber.join(fiber)
        assert.deepStrictEqual(results.map((result) => result._tag), partialRetry
          ? ["accepted", "accepted"] : ["accepted", "rejected"])
        assert.deepStrictEqual((yield* client.inbox.messages).map((item) => item.message.subject), partialRetry
          ? ["first", "second"] : ["first"])
      }).pipe(Effect.provide(Policy.layerRateLimiterMemory)))
  }

  it.effect("keeps earlier successes when a later chunk exceeds the recipient quota", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const limited = yield* Policy.withRateLimit({ recipients: { limit: 1, intervalMillis: 1 } })(client.transport)
      const result = yield* Email.sendBatch([
        messages[0]!, { ...messages[1]!, to: ["a@example.com", "b@example.com"] }
      ]).pipe(Effect.provide(layer(limited)))
      assert.deepStrictEqual(result.map((item) => item._tag), ["accepted", "rejected"])
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }).pipe(Effect.provide(Policy.layerRateLimiterMemory)))

  it.effect("routes fallback slots by outcome indexes on both legs", () =>
    Effect.gen(function* () {
      const primary = yield* Mock.makeClient()
      const secondary = yield* Mock.makeClient({ account: "secondary" })
      const first: Policy.NativeBatchTransport = {
        ...primary.transport,
        sendBatch: (envelopes) => Effect.gen(function* () {
          const receipt = yield* primary.transport.send(envelopes[2]!)
          return [
            { _tag: "accepted", index: 2, receipt },
            { _tag: "rejected", index: 1, error: unavailable() },
            { _tag: "rejected", index: 0, error: unavailable() }
          ] satisfies Array<MessageOutcome>
        })
      }
      const second = {
        ...secondary.transport,
        sendBatch: (envelopes: ReadonlyArray<PreparedEnvelope>) =>
          secondary.transport.sendBatch(envelopes).pipe(Effect.map((outcomes) => [...outcomes].reverse()))
      }
      const results = yield* Email.sendBatch(messages).pipe(Effect.provide(layer(Policy.withFallback(second)(first))))
      assert.deepStrictEqual(results.map((item) => [item.index, item._tag]), [[0, "accepted"], [1, "accepted"], [2, "accepted"]])
      assert.deepStrictEqual((yield* primary.inbox.messages).map((item) => item.message.subject), ["third"])
      assert.deepStrictEqual((yield* secondary.inbox.messages).map((item) => item.message.subject), ["first", "second"])
    }))

  for (const limit of ["capability", "rate"] as const) {
    it.effect(`enforces ${limit} recipient limits against the SMTP envelope`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        const base = {
          ...client.transport,
          capabilities: { ...client.transport.capabilities, ...(limit === "capability" ? { maxRecipientsPerMessage: 1 } : {}) }
        }
        const transport = limit === "rate"
          ? yield* Policy.withRateLimit({ recipients: { limit: 1, intervalMillis: 1000 } })(base)
          : base
        const result = yield* Effect.result(Email.send(messages[0]!, {
          rawEnvelope: { mailFrom: null, rcptTo: ["a@example.com", "b@example.com", "c@example.com"] }
        }).pipe(Effect.provide(layer(transport))))
        assert.strictEqual(result._tag === "Failure" && result.failure._tag, "UnsupportedCapability")
        assert.strictEqual((yield* client.inbox.messages).length, 0)
      }).pipe(Effect.provide(Policy.layerRateLimiterMemory)))
  }

  it.effect("opens the breaker for failing batch rows and recovers through a probe", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      let calls = 0
      let healthy = false
      const base = {
        ...client.transport,
        sendBatch: (envelopes: ReadonlyArray<PreparedEnvelope>) => Effect.suspend(() => {
          calls++
          return healthy ? client.transport.sendBatch(envelopes) : Effect.succeed(envelopes.map((_, index) =>
            ({ _tag: "rejected" as const, index, error: unavailable() })
          ))
        })
      }
      const breaker = yield* Policy.withCircuitBreaker({ failureThreshold: 1, resetTimeoutMillis: 1000 })(base)
      yield* Effect.gen(function* () {
        yield* Email.sendBatch([messages[0]!])
        yield* Email.sendBatch([messages[0]!])
        assert.strictEqual(calls, 1)
        healthy = true
        yield* TestClock.adjust(1000)
        const result = yield* Email.sendBatch([messages[0]!])
        assert.strictEqual(calls, 2)
        assert.strictEqual(result[0]!._tag, "accepted")
      }).pipe(Effect.provide(layer(breaker)))
    }))
})
