import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Email from "../src/Email"
import { certaintyOf } from "../src/EmailError"
import { providerMessageId, routeName } from "../src/Ids"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const message = (to: string, text = "Body") => ({
  to,
  subject: "Batch",
  text
})

describe("Email.sendBatch", () => {
  it.effect("returns one indexed outcome per input and isolates failures", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          { type: "accepted", providerMessageId: "rec_1" },
          { type: "rejected" },
          { type: "uncertain" }
        ]
      })
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: recorder.transport }
      })

      const outcomes = yield* Email.sendBatch(
        [
          message("one@example.com"),
          message("not-an-email"),
          message("two@example.com"),
          message("three@example.com")
        ],
        { concurrency: 1 }
      ).pipe(Effect.provide(layer))

      assert.deepStrictEqual(
        outcomes.map((outcome) => [outcome._tag, outcome.index]),
        [
          ["accepted", 0],
          ["invalid", 1],
          ["rejected", 2],
          ["uncertain", 3]
        ]
      )

      const accepted = outcomes[0]!
      assert.strictEqual(
        accepted._tag === "accepted" && accepted.receipt.providerMessageId,
        providerMessageId("rec_1")
      )
      const rejected = outcomes[2]!
      assert.strictEqual(
        rejected._tag === "rejected" && rejected.error._tag,
        "ProviderRejected"
      )
      const uncertain = outcomes[3]!
      assert.strictEqual(
        uncertain._tag === "uncertain" && certaintyOf(uncertain.error),
        "unknown"
      )

      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 3)
    }))

  it.effect("keeps capability failures inside their slots", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: recorder.transport }
      })

      const outcomes = yield* Email.sendBatch([
        { ...message("one@example.com"), tags: ["receipt"] },
        message("two@example.com")
      ]).pipe(Effect.provide(layer))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["invalid", "accepted"]
      )
      const invalid = outcomes[0]!
      assert.strictEqual(
        invalid._tag === "invalid" && invalid.error._tag,
        "UnsupportedCapability"
      )
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 1)
    }))

  it.effect("derives a unique provider idempotency key per message", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: recorder.transport }
      })

      yield* Email.sendBatch(
        [
          message("one@example.com"),
          message("two@example.com")
        ],
        { providerIdempotencyKey: "batch-key" }
      ).pipe(Effect.provide(layer))

      const attempts = yield* recorder.attempts
      const keys = attempts.map(
        (attempt) => attempt.envelope.providerIdempotencyKey
      )
      assert.strictEqual(keys.length, 2)
      assert.isTrue(keys.every((key) => key?.startsWith("batch-key:")))
      assert.notStrictEqual(keys[0], keys[1])
    }))

  it.effect("fails when the route does not exist", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: recorder.transport }
      })

      const error = yield* Email.sendBatch([message("one@example.com")], {
        route: routeName("missing")
      }).pipe(Effect.provide(layer), Effect.flip)

      assert.strictEqual(error._tag, "BatchExecutionError")
    }))
})
