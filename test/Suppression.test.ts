import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import {
  deliveryId,
  destinationId,
  makeDestination,
  tenantId
} from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import * as Suppression from "../src/Suppression"

const tenant = tenantId("tenant_suppression")
const recipient = "Blocked@Example.com"

const sqlLayer = Suppression.layerSql().pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
)

describe("SuppressionStore", () => {
  it.effect("normalizes, blocks, lists, and removes recipients", () =>
    Effect.gen(function* () {
      const store = yield* Suppression.SuppressionStore
      yield* store.suppress({
        tenantId: tenant,
        recipient: "Name <Blocked@Example.com>",
        reason: "hard bounce"
      })

      const blocked = yield* store.isSuppressed(
        tenant,
        "blocked@example.com"
      )
      const listed = yield* store.list(tenant)
      yield* store.remove(tenant, recipient)
      const removed = yield* store.isSuppressed(
        tenant,
        recipient
      )

      assert.isTrue(Option.isSome(blocked))
      assert.strictEqual(
        Option.isSome(blocked) ? blocked.value.reason : undefined,
        "hard bounce"
      )
      assert.strictEqual(listed[0]?.recipient, "blocked@example.com")
      assert.isTrue(Option.isNone(removed))
    }).pipe(Effect.provide(Suppression.layerMemory)))

  it.effect("ignores and prunes expired entries", () =>
    Effect.gen(function* () {
      const store = yield* Suppression.SuppressionStore
      const now = yield* DateTime.now
      yield* store.suppress({
        tenantId: tenant,
        recipient,
        expiresAt: DateTime.makeUnsafe(
          new Date(DateTime.toEpochMillis(now) - 1_000)
        )
      })

      const blocked = yield* store.isSuppressed(tenant, recipient)
      const pruned = yield* store.prune(now)

      assert.isTrue(Option.isNone(blocked))
      assert.strictEqual(pruned, 1)
    }).pipe(Effect.provide(Suppression.layerMemory)))

  it.effect("persists suppressions in SQL and prunes expired rows", () =>
    Effect.gen(function* () {
      const store = yield* Suppression.SuppressionStore
      const now = yield* DateTime.now
      yield* store.suppress({
        tenantId: tenant,
        recipient,
        reason: "complaint"
      })
      yield* store.suppress({
        tenantId: tenant,
        recipient: "expired@example.com",
        expiresAt: DateTime.makeUnsafe(
          new Date(DateTime.toEpochMillis(now) - 1_000)
        )
      })

      const blocked = yield* store.isSuppressed(
        tenant,
        "blocked@example.com"
      )
      const listed = yield* store.list(tenant)
      const pruned = yield* store.prune(now)

      assert.isTrue(Option.isSome(blocked))
      assert.strictEqual(listed.length, 2)
      assert.strictEqual(pruned, 1)
    }).pipe(Effect.provide(sqlLayer)))

  it.effect("does not suppress from a cross-account event", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const id = deliveryId("dlv_cross_account_complaint")
      const shared = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Suppression.layerMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )
      const app = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(Layer.provideMerge(shared))

      const blocked = yield* Effect.gen(function* () {
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        const suppression = yield* Suppression.SuppressionStore
        yield* admission.accept({
          tenantId: tenant,
          deliveryId: id,
          message: {
            to: "cross@example.com",
            subject: "Cross account",
            text: "Body"
          }
        })
        yield* admission.appendProviderEvent({
          id: "evt_cross_account",
          deliveryId: id,
          destinationId: destinationId(
            makeDestination({ provider: "mock", account: "other" })
          ),
          type: "complained",
          occurredAt: yield* DateTime.now
        })
        return yield* suppression.isSuppressed(
          tenant,
          "cross@example.com"
        )
      }).pipe(Effect.provide(app))

      assert.isTrue(Option.isNone(blocked))
    }))
  it.effect("blocks newly suppressed recipients before dispatch", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const id = deliveryId("dlv_suppressed_dispatch")
      const shared = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Suppression.layerMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        const suppression = yield* Suppression.SuppressionStore
        yield* Submissions.submit(queue, tenant, {
          deliveryId: id,
          defaultFrom: "billing@example.com",
          message: {
            to: "late@example.com",
            subject: "Late suppression",
            text: "Body"
          }
        })
        yield* suppression.suppress({
          tenantId: tenant,
          recipient: "late@example.com"
        })
        yield* queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        return yield* store.get(id)
      }).pipe(Effect.provide(shared))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "failed"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))
  it.effect("suppresses recipients after a complaint event", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const id = deliveryId("dlv_complaint_suppression")
      const shared = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Suppression.layerMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )
      const app = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(Layer.provideMerge(shared))

      const blocked = yield* Effect.gen(function* () {
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        const suppression = yield* Suppression.SuppressionStore
        yield* admission.accept({
          tenantId: tenant,
          deliveryId: id,
          message: {
            to: "complainer@example.com",
            subject: "Complaint",
            text: "Body"
          }
        })
        yield* admission.appendProviderEvent({
          id: "evt_complaint",
          deliveryId: id,
          type: "complained",
          occurredAt: yield* DateTime.now
        })
        return yield* suppression.isSuppressed(
          tenant,
          "complainer@example.com"
        )
      }).pipe(Effect.provide(app))

      assert.isTrue(Option.isSome(blocked))
    }))
  it.effect("blocks admission for suppressed recipients", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const shared = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Suppression.layerMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )
      const app = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(Layer.provideMerge(shared))

      const result = yield* Effect.gen(function* () {
        const store = yield* Suppression.SuppressionStore
        yield* store.suppress({
          tenantId: tenant,
          recipient: "blocked@example.com"
        })
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        return yield* Effect.result(
          admission.accept({
            tenantId: tenant,
            deliveryId: deliveryId("dlv_suppressed"),
            message: {
              to: "blocked@example.com",
              subject: "Blocked",
              text: "Body"
            }
          })
        )
      }).pipe(Effect.provide(app))

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "RecipientSuppressed"
      )
    }))
})
