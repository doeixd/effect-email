import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DeliveryStore, layerMemory } from "../src/DeliveryStore"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import {
  deliveryId,
  destinationId,
  makeDestination,
  providerMessageId,
  tenantId
} from "../src/Ids"
import {
  DeliveryUncertain,
  TransportUnavailable
} from "../src/EmailError"
import { makeReceipt } from "../src/Submission"
import { TestClock } from "effect/testing"

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
  const stores = [["memory", layerMemory], ["SQL", layer]] as const
  for (const [name, storeLayer] of stores) {
    it.effect(`${name}: active attempts reject redrive even with acknowledgment`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        yield* store.createIntent(input)
        const active = yield* store.beginAttempt(target, 1)
        for (const options of [undefined, { acknowledgeDuplicateRisk: true }]) {
          const result = yield* Effect.result(store.redrive(target, options))
          assert.strictEqual(result._tag === "Failure" && result.failure._tag, "StoreUnavailable")
        }
        const stored = yield* store.get(target)
        assert.strictEqual(Option.isSome(stored) && stored.value.claimId, active.claimId)
        assert.strictEqual(Option.isSome(stored) && stored.value.dispatchGeneration, 1)
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: scopes provider correlation before selecting the latest receipt`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const messageId = providerMessageId("account-scoped-id")
        const accountA = destinationId(makeDestination({ provider: "mock", account: "a" }))
        const accountB = destinationId(makeDestination({ provider: "mock", account: "b" }))
        for (const [id, destination] of [[target, accountA], [deliveryId("other-account"), accountB]] as const) {
          yield* store.createIntent({ ...input, deliveryId: id })
          yield* store.beginAttempt(id, 1)
          yield* store.recordAccepted(id, 1, makeReceipt({
            provider: "mock", destinationId: destination, providerMessageId: messageId,
            acceptedAt: yield* DateTime.now
          }))
          yield* TestClock.adjust(1)
        }
        const scoped = yield* store.findByProviderMessageId(messageId, { provider: "mock", destinationId: accountA })
        assert.strictEqual(Option.isSome(scoped) && scoped.value.deliveryId, target)
        yield* store.appendProviderEvent({
          id: "scoped-event", provider: "mock", destinationId: accountA,
          providerMessageId: messageId, type: "delivered", occurredAt: yield* DateTime.now
        })
        const projected = yield* store.get(target)
        assert.strictEqual(Option.isSome(projected) && projected.value.status, "delivered")
        assert.strictEqual((yield* store.listEvents(target)).length, 1)
        const other = yield* store.get(deliveryId("other-account"))
        assert.strictEqual(Option.isSome(other) && other.value.status, "accepted")
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: preserves durable wait subscriptions in backup and restore`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const wait = { executionId: "wait-1", tenantId: tenantId("wait-tenant"), deliveryId: target, types: ["delivered"] as const }
        yield* store.registerEventWait(wait)
        yield* store.registerEventWait({ ...wait, types: ["bounced"] })
        const snapshot = yield* store.snapshot
        yield* store.removeEventWait(wait.executionId)
        assert.deepStrictEqual(yield* store.listEventWaits(target), [])
        yield* store.restore(snapshot)
        assert.deepStrictEqual(yield* store.listEventWaits(target), [wait])
        yield* store.removeEventWait(wait.executionId)
        yield* store.removeEventWait(wait.executionId)
        assert.deepStrictEqual(yield* store.listEventWaits(target), [])
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: cancellation prevents atomic claim acquisition`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        yield* store.createIntent(input)
        assert.strictEqual(yield* store.requestCancellation(target), "canceled-before-dispatch")
        const attempt = yield* store.beginAttempt(target, 1)
        assert.strictEqual(attempt.status, "canceled")
        assert.isUndefined(attempt.claimId)
        assert.strictEqual(attempt.attempts, 0)
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: rejects events for earlier provider messages and generations`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const destination = destinationId(makeDestination({ provider: "mock", account: "default" }))
        const receipt = (id: string) => makeReceipt({
          provider: "mock", destinationId: destination,
          providerMessageId: providerMessageId(id),
          acceptedAt: DateTime.makeUnsafe(0)
        })
        yield* store.createIntent(input)
        yield* store.beginAttempt(target, 1)
        yield* store.recordAccepted(target, 1, receipt("old"))
        yield* store.redrive(target)
        yield* store.beginAttempt(target, 2)
        yield* store.recordAccepted(target, 2, receipt("new"))
        for (const [id, messageId, generation] of [["old-message", "old", undefined], ["old-generation", "new", 1]] as const) {
          yield* store.appendProviderEvent({
            id, deliveryId: target, provider: "mock", destinationId: destination,
            providerMessageId: providerMessageId(messageId), dispatchGeneration: generation,
            type: "bounced", occurredAt: DateTime.makeUnsafe(1_000)
          })
        }
        const accepted = yield* store.get(target)
        assert.strictEqual(Option.isSome(accepted) && accepted.value.status, "accepted")
        yield* store.appendProviderEvent({
          id: "current", deliveryId: target, provider: "mock", destinationId: destination,
          providerMessageId: providerMessageId("new"), dispatchGeneration: 2,
          type: "delivered", occurredAt: DateTime.makeUnsafe(2_000)
        })
        const delivered = yield* store.get(target)
        assert.strictEqual(Option.isSome(delivered) && delivered.value.status, "delivered")
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: queue publication preserves an active worker claim`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        yield* store.createIntent(input)
        const claimed = yield* store.beginAttempt(target, 1)
        yield* store.markQueued(target, 1)
        const queued = Option.getOrElse(
          yield* store.get(target), () => assert.fail("expected queued intent")
        )
        assert.strictEqual(queued.claimId, claimed.claimId)
        assert.deepStrictEqual(queued.claimExpiresAt, claimed.claimExpiresAt)
        assert.deepStrictEqual(queued.updatedAt, claimed.updatedAt)
        assert.isDefined(queued.queuedAt)
        const duplicate = yield* Effect.result(
          store.beginAttempt(target, 1)
        )
        assert.strictEqual(duplicate._tag, "Failure")
        yield* store.recordAccepted(
          target, 1,
          makeReceipt({
            provider: "mock",
            destinationId: destinationId(
              makeDestination({ provider: "mock", account: "default" })
            ),
            acceptedAt: yield* DateTime.now
          }),
          claimed.claimId
        )
        const accepted = yield* store.get(target)
        assert.strictEqual(
          Option.isSome(accepted) && accepted.value.status, "accepted"
        )
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: rejects reuse of another tenant's delivery id`, () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const first = yield* store.createIntent({
          ...input, tenantId: tenantId("tenant-a")
        })
        const replay = yield* store.createIntent({
          ...input, tenantId: tenantId("tenant-a")
        })
        assert.strictEqual(replay.fingerprint, first.fingerprint)
        for (const otherTenant of [tenantId("tenant-b"), undefined]) {
          const result = yield* Effect.result(
            store.createIntent({ ...input, tenantId: otherTenant })
          )
          assert.strictEqual(
            result._tag === "Failure" && result.failure._tag,
            "IdempotencyConflict"
          )
        }
        const stored = yield* store.get(target)
        assert.strictEqual(
          Option.isSome(stored) && stored.value.tenantId, tenantId("tenant-a")
        )
      }).pipe(Effect.provide(storeLayer)))
  }

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
      assert.strictEqual(pruned.intents, 1)
      assert.strictEqual(pruned.events, 1)
      assert.isTrue(Option.isNone(yield* store.get(target)))
      assert.strictEqual((yield* store.listEvents(target)).length, 0)
    }).pipe(Effect.provide(layer)))

  it.effect("reports cancellation outcomes and gates uncertain redrive", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const pendingId = deliveryId("dlv_sql_cancel_pending")
      const uncertainId = deliveryId("dlv_sql_cancel_uncertain")
      yield* store.createIntent({ ...input, deliveryId: pendingId })
      yield* store.createIntent({ ...input, deliveryId: uncertainId })
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
      const blocked = yield* Effect.result(store.redrive(uncertainId))
      const allowed = yield* store.redrive(uncertainId, {
        acknowledgeDuplicateRisk: true
      })

      assert.strictEqual(pending, "canceled-before-dispatch")
      assert.strictEqual(
        blocked._tag === "Failure" && blocked.failure._tag,
        "StoreUnavailable"
      )
      assert.strictEqual(allowed.status, "pending")
    }).pipe(Effect.provide(layer)))
  it.effect("summarizes delivery status counts", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const id = deliveryId("dlv_sql_summary")
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordFailed(
        id,
        1,
        TransportUnavailable.new({
          message: "failed",
          provider: "mock"
        })
      )
      const summary = yield* store.statusSummary

      assert.strictEqual(
        summary.find((item) => item.status === "failed")?.count,
        1
      )
    }).pipe(Effect.provide(layer)))
  it.effect("pages tenant queries and records redrive audit", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const tenant = tenantId("tenant_sql_query")
      const ids = [
        deliveryId("dlv_sql_query_1"),
        deliveryId("dlv_sql_query_2")
      ]
      for (const id of ids) {
        yield* store.createIntent({
          ...input,
          deliveryId: id,
          tenantId: tenant
        })
      }
      const first = yield* store.listForTenant({
        tenantId: tenant,
        limit: 1
      })
      const second = yield* store.listForTenant({
        tenantId: tenant,
        limit: 1,
        after: first[0]!.deliveryId
      })
      yield* store.beginAttempt(ids[0]!, 1)
      yield* store.recordUncertain(
        ids[0]!,
        1,
        DeliveryUncertain.new({
          message: "unknown",
          provider: "mock"
        })
      )
      yield* store.redrive(ids[0]!, {
        acknowledgeDuplicateRisk: true,
        actor: "operator@example.com",
        reason: "verified"
      })
      const stored = yield* store.get(ids[0]!)

      assert.deepStrictEqual(
        [first[0]?.deliveryId, second[0]?.deliveryId],
        ids
      )
      assert.strictEqual(
        Option.isSome(stored)
          ? stored.value.redriveHistory?.[0]?.actor
          : undefined,
        "operator@example.com"
      )
    }).pipe(Effect.provide(layer)))
  it.effect("paginates unqueued and stale intents", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const tenant = tenantId("tenant_page")
      const ids = [
        deliveryId("dlv_sql_page_1"),
        deliveryId("dlv_sql_page_2")
      ]
      for (const id of ids) {
        yield* store.createIntent({
          ...input,
          deliveryId: id,
          tenantId: tenant
        })
      }

      const firstPage = yield* store.listUnqueuedForTenant({
        tenantId: tenant,
        limit: 1
      })
      const secondPage = yield* store.listUnqueuedForTenant({
        tenantId: tenant,
        limit: 1,
        after: firstPage[0]!.deliveryId
      })
      yield* store.beginAttempt(ids[0]!, 1)
      const stale = yield* store.listStaleInProgress({
        now: DateTime.makeUnsafe(new Date(Date.now() + 60_000)),
        updatedBefore: DateTime.makeUnsafe(new Date(Date.now() + 60_000)),
        limit: 10
      })

      assert.deepStrictEqual(
        [firstPage[0]?.deliveryId, secondPage[0]?.deliveryId],
        ids
      )
      assert.deepStrictEqual(
        stale.map((intent) => intent.deliveryId),
        [ids[0]]
      )
    }).pipe(Effect.provide(layer)))
  it.effect("atomically creates intents and claims attempts", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const id = deliveryId("dlv_sql_atomic")
      const atomicInput = { ...input, deliveryId: id }
      const [first, second] = yield* Effect.all(
        [
          store.createIntent(atomicInput),
          store.createIntent(atomicInput)
        ],
        { concurrency: "unbounded" }
      )
      const conflict = yield* Effect.result(
        store.createIntent({
          ...atomicInput,
          message: { ...atomicInput.message, subject: "Different" }
        })
      )
      const claims = yield* Effect.all(
        [
          Effect.result(store.beginAttempt(id, 1)),
          Effect.result(store.beginAttempt(id, 1))
        ],
        { concurrency: "unbounded" }
      )

      assert.strictEqual(first.deliveryId, second.deliveryId)
      assert.strictEqual(
        conflict._tag === "Failure" && conflict.failure._tag,
        "IdempotencyConflict"
      )
      assert.strictEqual(
        claims.filter((claim) => claim._tag === "Success").length,
        1
      )
    }).pipe(Effect.provide(layer)))
  it.effect("correlates provider events by receipt message id", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const id = deliveryId("dlv_sql_event_correlation")
      const destination = makeDestination({
        provider: "mock",
        account: "default"
      })
      yield* store.createIntent({ ...input, deliveryId: id })
      yield* store.beginAttempt(id, 1)
      yield* store.recordAccepted(id, 1, makeReceipt({
        provider: "mock",
        destinationId: destinationId(destination),
        deliveryId: id,
        providerMessageId: providerMessageId("sql_provider_message_1"),
        acceptedAt: DateTime.makeUnsafe(new Date(0))
      }))
      const inserted = yield* store.appendProviderEvent({
        id: "sql_event_correlated",
        provider: "mock",
        destinationId: destinationId(destination),
        providerMessageId: providerMessageId("sql_provider_message_1"),
        type: "delivered",
        occurredAt: DateTime.makeUnsafe(new Date(1_000))
      })
      const stored = yield* store.get(id)
      const events = yield* store.listEvents(id)

      assert.isTrue(inserted)
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "delivered"
      )
      assert.strictEqual(events.length, 1)
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
          TransportUnavailable.new({
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
        const attempts = yield* store.listAttempts(id)

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
          events: events.map((event) => event.type),
          attempts: attempts.map((attempt) => attempt.status)
        }
      })

      const memory = yield* run.pipe(
        Effect.provide(layerMemory)
      )
      const sql = yield* run.pipe(Effect.provide(layer))

      assert.deepStrictEqual(memory, sql)
    }))
})
