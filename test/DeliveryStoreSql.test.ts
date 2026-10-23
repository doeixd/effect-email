import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DeliveryStore, layerMemory } from "../src/DeliveryStore"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import { deliveryId, destinationId, makeDestination } from "../src/Ids"
import { TransportUnavailable } from "../src/EmailError"
import { makeReceipt } from "../src/Submission"

const target = deliveryId("dlv_sql_store_1")

const layer = DeliveryStoreSql.layerSql().pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
)

const input = {
  deliveryId: target,
  message: {
    to: "user@example.com",
    subject: "SQL",
    text: "Body"
  },
  defaultFrom: "billing@example.com"
} as const

describe("DeliveryStore SQL", () => {
  it.effect("persists cancellation tombstones", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const target = deliveryId("dlv_sql_cancel")
      yield* store.requestCancellation(target)
      const canceled = yield* store.isCancellationRequested(target)
      const intent = yield* store.createIntent({
        ...input,
        deliveryId: target
      })
      const snapshot = yield* store.snapshot

      assert.isTrue(canceled)
      assert.isTrue(intent.cancellationRequested)
      assert.include(snapshot.cancellations ?? [], target)
    }).pipe(Effect.provide(layer)))

  it.effect("persists intents and provider events", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const created = yield* store.createIntent(input)
      const attempt = yield* store.beginAttempt(target, 1)
      yield* store.recordAccepted(target, 1, {
        deliveryId: target,
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        acceptedAt: yield* DateTime.now
      })
      const event = yield* store.appendProviderEvent({
        id: "sql_event_1",
        deliveryId: target,
        type: "delivered",
        occurredAt: yield* DateTime.now
      })
      const stored = yield* store.get(target)
      const events = yield* store.listEvents(target)
      const snapshot = yield* store.snapshot

      assert.strictEqual(created.deliveryId, target)
      assert.strictEqual(attempt.attempts, 1)
      assert.isTrue(event)
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "delivered"
      )
      assert.strictEqual(events.length, 1)
      assert.strictEqual(snapshot.intents.length, 1)

      const cutoff = DateTime.makeUnsafe(
        new Date(Date.now() + 60_000)
      )
      const pruned = yield* store.prune({
        intentsBefore: cutoff,
        eventsBefore: cutoff
      })
      assert.strictEqual(pruned.intents, 0)
      assert.strictEqual(pruned.events, 1)
      assert.strictEqual((yield* store.listEvents(target)).length, 0)
    }).pipe(Effect.provide(layer)))

  it.effect("keeps memory and SQL lifecycle transitions in parity", () =>
    Effect.gen(function* () {
      const run = Effect.gen(function* () {
        const store = yield* DeliveryStore
        const id = deliveryId("dlv_sql_parity")
        const receipt = makeReceipt({
          provider: "mock",
          destinationId: destinationId(
            makeDestination({ provider: "mock", account: "default" })
          ),
          deliveryId: id,
          acceptedAt: DateTime.makeUnsafe(new Date(0))
        })

        yield* store.createIntent({ ...input, deliveryId: id })
        yield* store.beginAttempt(id, 1)
        yield* store.recordDeferred(
          id,
          1,
          new TransportUnavailable({
            message: "retry",
            provider: "mock",
            retryable: true
          }),
          1_000
        )
        yield* store.beginAttempt(id, 1)
        yield* store.recordAccepted(id, 1, receipt)
        yield* store.appendProviderEvent({
          id: "parity_delivered",
          deliveryId: id,
          type: "delivered",
          occurredAt: DateTime.makeUnsafe(new Date(1))
        })

        const delivered = yield* store.get(id)
        yield* store.redrive(id)
        yield* store.requestCancellation(id)
        const final = yield* store.get(id)
        const events = yield* store.listEvents(id)

        return {
          deliveredStatus: Option.isSome(delivered)
            ? delivered.value.status
            : undefined,
          deliveredAttempts: Option.isSome(delivered)
            ? delivered.value.attempts
            : undefined,
          deliveredReceipt: Option.isSome(delivered)
            ? delivered.value.receipt?.provider
            : undefined,
          finalStatus: Option.isSome(final)
            ? final.value.status
            : undefined,
          finalGeneration: Option.isSome(final)
            ? final.value.dispatchGeneration
            : undefined,
          finalAttempts: Option.isSome(final)
            ? final.value.attempts
            : undefined,
          cancellationRequested: Option.isSome(final)
            ? final.value.cancellationRequested
            : undefined,
          events: events.map((event) => event.type)
        }
      })

      const memory = yield* run.pipe(
        Effect.provide(layerMemory)
      )
      const sql = yield* run.pipe(Effect.provide(layer))

      assert.deepStrictEqual(memory, sql)
    }))
})
