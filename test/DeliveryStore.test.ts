import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import { DeliveryUncertain, StoreUnavailable } from "../src/EmailError"
import {
  attemptId,
  deliveryId,
  destinationId,
  makeDestination,
  providerMessageId,
  tenantId
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
        StoreUnavailable.new({ message: "failed" })
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
      const attempts = yield* store.listAttempts(target)

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
      assert.strictEqual(attempts.length, 1)
      assert.strictEqual(attempts[0]?.status, "accepted")
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
  it.effect("reports cancellation outcomes and requires redrive acknowledgment", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const pendingId = deliveryId("dlv_cancel_pending")
      const activeId = deliveryId("dlv_cancel_active")
      const acceptedId = deliveryId("dlv_cancel_accepted")
      const uncertainId = deliveryId("dlv_cancel_uncertain")

      for (const id of [pendingId, activeId, acceptedId, uncertainId]) {
        yield* store.createIntent({ ...input, deliveryId: id })
      }
      yield* store.beginAttempt(activeId, 1)
      yield* store.beginAttempt(acceptedId, 1)
      yield* store.recordAccepted(acceptedId, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        deliveryId: acceptedId,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))
      yield* store.beginAttempt(uncertainId, 1)
      yield* store.recordUncertain(
        uncertainId,
        1,
        DeliveryUncertain.new({
          message: "unknown",
          provider: "mock"
        })
      )

      const pending = yield* store.requestCancellation(pendingId)
      const active = yield* store.requestCancellation(activeId)
      const accepted = yield* store.requestCancellation(acceptedId)
      const blocked = yield* Effect.result(store.redrive(uncertainId))
      const allowed = yield* store.redrive(uncertainId, {
        acknowledgeDuplicateRisk: true
      })

      assert.strictEqual(pending, "canceled-before-dispatch")
      assert.strictEqual(active, "cancellation-requested")
      assert.strictEqual(accepted, "already-submitted")
      assert.strictEqual(
        blocked._tag === "Failure" && blocked.failure._tag,
        "StoreUnavailable"
      )
      assert.strictEqual(allowed.status, "pending")
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("clears event ordering when a delivery is redriven", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_redrive_event_order")
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordAccepted(id, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        deliveryId: id,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))
      yield* store.appendProviderEvent({
        id: "evt_before_redrive",
        deliveryId: id,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(2_000))
      })
      yield* store.redrive(id, { acknowledgeDuplicateRisk: true })
      yield* store.appendProviderEvent({
        id: "evt_after_redrive",
        deliveryId: id,
        dispatchGeneration: 2,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(1_000))
      })
      const stored = yield* store.get(id)

      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "delivered"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("keeps event ordering after a repeated status event", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_event_repeat_order")
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordAccepted(id, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        deliveryId: id,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))
      yield* store.appendProviderEvent({
        id: "evt_delivered_first",
        deliveryId: id,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(1_000))
      })
      yield* store.appendProviderEvent({
        id: "evt_delivered_repeat",
        deliveryId: id,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(2_000))
      })
      yield* store.appendProviderEvent({
        id: "evt_bounced_old",
        deliveryId: id,
        type: "bounced",
        occurredAt: DateTime.makeUnsafe(new Date(1_500))
      })
      const stored = yield* store.get(id)

      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "delivered"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("pages tenant-scoped delivery queries", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const tenant = tenantId("tenant_query")
      const ids = [
        deliveryId("dlv_query_1"),
        deliveryId("dlv_query_2")
      ]
      for (const id of ids) {
        yield* store.createIntent({
          ...input,
          deliveryId: id,
          tenantId: tenant
        })
      }
      yield* store.createIntent({
        ...input,
        deliveryId: deliveryId("dlv_query_other"),
        tenantId: tenantId("tenant_other")
      })

      const first = yield* store.listForTenant({
        tenantId: tenant,
        limit: 1
      })
      const second = yield* store.listForTenant({
        tenantId: tenant,
        limit: 1,
        after: first[0]!.deliveryId
      })

      assert.deepStrictEqual(
        [first[0]?.deliveryId, second[0]?.deliveryId],
        ids
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("rejects a new attempt after terminal acceptance", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_terminal_claim")
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordAccepted(id, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(
          makeDestination({ provider: "mock", account: "default" })
        ),
        deliveryId: id,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))
      const retry = yield* Effect.result(store.beginAttempt(id, 1))

      assert.strictEqual(
        retry._tag === "Failure" && retry.failure._tag,
        "StoreUnavailable"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("records redrive actor and reason", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_redrive_audit")
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordUncertain(
        id,
        1,
        DeliveryUncertain.new({
          message: "unknown",
          provider: "mock"
        })
      )
      yield* store.redrive(id, {
        acknowledgeDuplicateRisk: true,
        actor: "operator@example.com",
        reason: "provider confirmed non-delivery"
      })
      const stored = yield* store.get(id)
      const history = Option.isSome(stored)
        ? stored.value.redriveHistory ?? []
        : []

      assert.strictEqual(history.length, 1)
      assert.strictEqual(history[0]?.actor, "operator@example.com")
      assert.strictEqual(
        history[0]?.reason,
        "provider confirmed non-delivery"
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("summarizes status counts without loading all intents", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const pending = deliveryId("dlv_summary_pending")
      const failed = deliveryId("dlv_summary_failed")
      yield* store.createIntent({ ...input, deliveryId: pending })
      yield* store.createIntent({ ...input, deliveryId: failed })
      yield* store.beginAttempt(failed, 1)
      yield* store.recordFailed(
        failed,
        1,
        StoreUnavailable.new({ message: "failed" })
      )
      const summary = yield* store.statusSummary
      const count = (status: string) =>
        summary.find((item) => item.status === status)?.count

      assert.strictEqual(count("pending"), 1)
      assert.strictEqual(count("failed"), 1)
      assert.isDefined(
        summary.find((item) => item.status === "failed")
          ?.oldestUpdatedAt
      )
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("correlates and projects provider events deterministically", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_store_events")
      const destination = makeDestination({
        provider: "mock",
        account: "default"
      })
      const otherDestination = makeDestination({
        provider: "mock",
        account: "other"
      })
      const messageId = providerMessageId("provider_message_1")

      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordAccepted(id, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(destination),
        deliveryId: id,
        providerMessageId: messageId,
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))

      const delivered = yield* store.appendProviderEvent({
        id: "event_delivered",
        provider: "mock",
        destinationId: destinationId(destination),
        providerMessageId: messageId,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(2_000))
      })
      const older = yield* store.appendProviderEvent({
        id: "event_older_bounce",
        provider: "mock",
        destinationId: destinationId(destination),
        providerMessageId: messageId,
        type: "bounced",
        occurredAt: DateTime.makeUnsafe(new Date(1_000))
      })
      const newer = yield* store.appendProviderEvent({
        id: "event_newer_complaint",
        provider: "mock",
        destinationId: destinationId(destination),
        providerMessageId: messageId,
        type: "complained",
        occurredAt: DateTime.makeUnsafe(new Date(3_000))
      })
      const crossAccount = yield* store.appendProviderEvent({
        id: "event_cross_account",
        provider: "mock",
        destinationId: destinationId(otherDestination),
        providerMessageId: messageId,
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(4_000))
      })
      const stored = yield* store.get(id)
      const events = yield* store.listEvents(id)

      assert.isTrue(delivered)
      assert.isTrue(older)
      assert.isTrue(newer)
      assert.isTrue(crossAccount)
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "complained"
      )
      assert.strictEqual(events.length, 3)
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
  it.effect("retains non-terminal work during pruning", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      const id = deliveryId("dlv_prune_active")
      yield* store.createIntent({ ...input, deliveryId: id })
      const pruned = yield* store.prune({
        intentsBefore: DateTime.makeUnsafe(
          new Date(Date.now() + 60_000)
        )
      })

      assert.strictEqual(pruned.intents, 0)
      assert.isTrue(Option.isSome(yield* store.get(id)))
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
