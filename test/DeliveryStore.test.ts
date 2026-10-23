import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import { StoreUnavailable } from "../src/EmailError"
import {
  attemptId,
  deliveryId,
  destinationId,
  makeDestination
} from "../src/Ids"
import { makeReceipt } from "../src/Submission"

const target = deliveryId("dlv_store_1")

const input = {
  deliveryId: target,
  message: {
    to: "customer@example.com",
    subject: "Store",
    text: "Body"
  },
  defaultFrom: "billing@example.com"
} as const

describe("DeliveryStore", () => {
  it.effect("returns the existing intent for an identical replay", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const first = yield* store.createIntent(input)
      const second = yield* store.createIntent(input)

      assert.strictEqual(first.deliveryId, second.deliveryId)
      assert.strictEqual(first.fingerprint, second.fingerprint)
      assert.strictEqual(second.status, "pending")
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("rejects conflicting content under the same delivery id", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent(input)
      const result = yield* Effect.result(
        store.createIntent({
          ...input,
          message: { ...input.message, subject: "Different" }
        })
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "IdempotencyConflict"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("lists provider events in occurrence order", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.appendProviderEvent({
        id: "evt_late_ingest",
        deliveryId: target,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z")
      })
      yield* store.appendProviderEvent({
        id: "evt_early_ingest",
        deliveryId: target,
        type: "opened",
        occurredAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z")
      })

      const events = yield* store.listEvents(target)
      assert.deepStrictEqual(
        events.map((event) => event.id),
        ["evt_early_ingest", "evt_late_ingest"]
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("records cancellation before an intent exists", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const target = deliveryId("dlv_cancel_before_create")
      yield* store.requestCancellation(target)
      assert.isTrue(yield* store.isCancellationRequested(target))

      const intent = yield* store.createIntent({
        ...input,
        deliveryId: target
      })
      assert.isTrue(intent.cancellationRequested)

      const redriven = yield* store.redrive(target)
      assert.isFalse(redriven.cancellationRequested)
      assert.isFalse(yield* store.isCancellationRequested(target))
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("prunes terminal intents and old events", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent(input)
      yield* store.beginAttempt(target, 1)
      yield* store.recordFailed(
        target,
        1,
        new StoreUnavailable({ message: "failed" })
      )
      yield* store.appendProviderEvent({
        id: "event_prune",
        deliveryId: target,
        type: "bounced",
        occurredAt: yield* DateTime.now
      })

      const cutoff = DateTime.makeUnsafe(
        new Date(Date.now() + 60_000)
      )
      const pruned = yield* store.prune({
        intentsBefore: cutoff,
        eventsBefore: cutoff
      })

      assert.strictEqual(pruned.intents, 1)
      assert.strictEqual(pruned.events, 1)
      assert.isTrue(Option.isNone(yield* store.get(target)))
      assert.strictEqual(
        (yield* store.listEvents(target)).length,
        0
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("increments attempts and rejects stale generations", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent(input)
      const attempt = yield* store.beginAttempt(target, 1)
      const stale = yield* Effect.result(store.beginAttempt(target, 2))

      assert.strictEqual(attempt.attempts, 1)
      assert.strictEqual(attempt.status, "in-progress")
      assert.strictEqual(
        stale._tag === "Failure" && stale.failure._tag,
        "StoreUnavailable"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("allows only one active claim and rejects stale claim results", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent(input)
      const claimed = yield* store.beginAttempt(target, 1)
      const second = yield* Effect.result(
        store.beginAttempt(target, 1)
      )
      const receipt = makeReceipt({
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        deliveryId: target,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      })
      const stale = yield* Effect.result(
        store.recordAccepted(
          target,
          1,
          receipt,
          attemptId("att_wrong")
        )
      )
      yield* store.recordAccepted(target, 1, receipt, claimed.claimId)
      const stored = yield* store.get(target)

      assert.isDefined(claimed.claimId)
      assert.strictEqual(
        second._tag === "Failure" && second.failure._tag,
        "StoreUnavailable"
      )
      assert.strictEqual(
        stale._tag === "Failure" && stale.failure._tag,
        "StoreUnavailable"
      )
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "accepted"
      )
      assert.isUndefined(
        Option.isSome(stored) ? stored.value.claimId : "missing"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("creates one intent under concurrent identical admission", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const [first, second] = yield* Effect.all(
        [store.createIntent(input), store.createIntent(input)],
        { concurrency: "unbounded" }
      )
      const conflict = yield* Effect.result(
        store.createIntent({
          ...input,
          message: { ...input.message, subject: "Different" }
        })
      )

      assert.strictEqual(first.deliveryId, second.deliveryId)
      assert.strictEqual(
        conflict._tag === "Failure" && conflict.failure._tag,
        "IdempotencyConflict"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("deduplicates provider events", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const event: DeliveryStore.DeliveryEvent = {
        id: "event_1",
        deliveryId: target,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date())
      }

      const first = yield* store.appendProviderEvent(event)
      const second = yield* store.appendProviderEvent(event)
      const listed = yield* store.listEvents(target)

      assert.isTrue(first)
      assert.isFalse(second)
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]?.type, "delivered")
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("records cancellation and uncertain intents", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent(input)
      yield* store.requestCancellation(target)
      const canceled = yield* store.get(target)

      assert.isTrue(Option.isSome(canceled))
      assert.isTrue(
        Option.isSome(canceled) && canceled.value.cancellationRequested
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
})
