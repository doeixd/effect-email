import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Layer, Option, Redacted } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { PgClient } from "@effect/sql-pg"
import * as SqlClient from "effect/sql/SqlClient"
import { DeliveryStore } from "../src/DeliveryStore"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import { StoreUnavailable } from "../src/EmailError"
import {
  deliveryId,
  destinationId,
  makeDestination,
  tenantId
} from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"

const url = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`
const deliveryTable = `effect_email_delivery_${suffix}`
const queueTable = `effect_queue_${suffix}`
const tenant = tenantId("tenant_pg")
const delivery = deliveryId("dlv_pg_1")

describe("PostgreSQL integration", () => {
  for (const first of ["create", "cancel"] as const) {
    it.live.skipIf(url === undefined)(`serializes absent-intent cancellation (${first} starts first)`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* DeliveryStore
        const observer = yield* PgClient.make({ url: Redacted.make(url ?? ""), maxConnections: 1 }).pipe(Effect.provide(Reactivity.layer))
        const barrier = first === "create" ? 9382701 : 9382702
        const table = `${deliveryTable}_${first}`
        const functionName = `pause_${suffix}_${first}`
        const pausedTable = `${table}_${first === "create" ? "intents" : "cancellations"}`
        const id = deliveryId(`cancel_race_${first}`)
        yield* sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${barrier}); RETURN NEW; END $$`)
        yield* sql.unsafe(`CREATE TRIGGER pause_insert BEFORE INSERT ON ${pausedTable} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
        yield* Effect.acquireUseRelease(
          observer.unsafe(`SELECT pg_advisory_lock(${barrier})`),
          () => Effect.gen(function* () {
            const create = store.createIntent({
              deliveryId: id, tenantId: tenant,
              message: { to: "race@example.com", subject: "Cancel race", text: "Body" },
              defaultFrom: "sender@example.com"
            })
            const cancel = store.requestCancellation(id)
            const initial = yield* (first === "create" ? create.pipe(Effect.asVoid) : cancel.pipe(Effect.asVoid)).pipe(Effect.forkChild)
            const waitForBlocked = (count: number) => Effect.gen(function* () {
              while (true) {
                const rows = yield* observer<{ readonly count: string }>`SELECT count(*) AS count FROM pg_stat_activity WHERE wait_event = 'advisory' AND application_name = ${table}`
                if (Number(rows[0]!.count) >= count) return
                yield* Effect.sleep(5)
              }
            }).pipe(Effect.timeout("2 seconds"))
            yield* waitForBlocked(1)
            const following = yield* (first === "create" ? cancel.pipe(Effect.asVoid) : create.pipe(Effect.asVoid)).pipe(Effect.forkChild)
            yield* waitForBlocked(2)
            assert.isUndefined(following.pollUnsafe())
            yield* observer.unsafe(`SELECT pg_advisory_unlock(${barrier})`)
            yield* Fiber.join(initial)
            yield* Fiber.join(following)
            assert.strictEqual(yield* store.isCancellationRequested(id), true)
            const claimed = yield* store.beginAttempt(id, 1)
            assert.strictEqual(claimed.status, "canceled")
            assert.isUndefined(claimed.claimId)
            assert.strictEqual(claimed.attempts, 0)
          }),
          () => observer.unsafe(`SELECT pg_advisory_unlock(${barrier})`).pipe(Effect.orDie)
        )
      }).pipe(Effect.provide(
        DeliveryStoreSql.layerSql({ tableName: `${deliveryTable}_${first}` }).pipe(
          Layer.provideMerge(PgClient.layer({ url: Redacted.make(url ?? ""), applicationName: `${deliveryTable}_${first}` }))
        )
      ), Effect.scoped))
  }

  it.effect.skipIf(url === undefined)(
    "rolls back delivery and queue writes in one transaction",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* DeliveryStore
        const queue = yield* Submissions.make({
          name: "email.outbox.pg"
        })

        const result = yield* Effect.result(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.createIntent({
                deliveryId: delivery,
                tenantId: tenant,
                message: {
                  to: "pg@example.com",
                  subject: "PG outbox",
                  text: "Body"
                },
                defaultFrom: "billing@example.com"
              })
              yield* Submissions.offer(queue, {
                version: 1,
                tenantId: tenant,
                deliveryId: delivery,
                dispatchGeneration: 1
              })
              return yield* StoreUnavailable.new({
                message: "rollback"
              })
            })
          )
        )
        const stored = yield* store.get(delivery)
        const counts = yield* sql<{ readonly count: string }>`
          SELECT COUNT(*) AS count FROM ${sql(queueTable)}
        `

        assert.strictEqual(
          result._tag === "Failure" && result.failure._tag,
          "StoreUnavailable"
        )
        assert.isTrue(Option.isNone(stored))
        assert.strictEqual(Number(counts[0]?.count ?? 0), 0)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeliveryStoreSql.layerSql({ tableName: deliveryTable }),
            Submissions.layerFactorySql({
              tableName: queueTable
            })
          ).pipe(
            Layer.provideMerge(
              PgClient.layer({
                url: Redacted.make(url ?? "")
              })
            )
          )
        )
      )
  )

  it.effect.skipIf(url === undefined)(
    "atomically creates and claims across concurrent connections",
    () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const id = deliveryId("dlv_pg_atomic")
        const atomicInput = {
          deliveryId: id,
          tenantId: tenant,
          message: {
            to: "pg-atomic@example.com",
            subject: "PG atomic",
            text: "Body"
          },
          defaultFrom: "billing@example.com"
        } as const
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
      }).pipe(
        Effect.provide(
          DeliveryStoreSql.layerSql({ tableName: deliveryTable }).pipe(
            Layer.provideMerge(
              PgClient.layer({
                url: Redacted.make(url ?? "")
              })
            )
          )
        )
      )
  )
  it.effect.skipIf(url === undefined)(
    "isolates concurrent delivery transactions",
    () =>
      Effect.gen(function* () {
        const store = yield* DeliveryStore
        const target = destinationId(
          makeDestination({ provider: "mock", account: "default" })
        )
        const ids = Array.from({ length: 20 }, (_, index) =>
          deliveryId(`dlv_pg_concurrent_${index}`)
        )

        yield* Effect.forEach(
          ids,
          (id, index) =>
            store.createIntent({
              deliveryId: id,
              tenantId: tenant,
              message: {
                to: `pg${index}@example.com`,
                subject: "PG concurrent",
                text: "Body"
              },
              defaultFrom: "billing@example.com"
            }),
          { concurrency: "unbounded" }
        )
        yield* Effect.forEach(
          ids,
          (id) => store.beginAttempt(id, 1),
          { concurrency: "unbounded" }
        )
        const acceptedAt = yield* DateTime.now
        yield* Effect.forEach(
          ids,
          (id) =>
            store.recordAccepted(id, 1, {
              deliveryId: id,
              provider: "mock",
              destinationId: target,
              acceptedAt
            }),
          { concurrency: "unbounded" }
        )

        const stored = yield* Effect.forEach(
          ids,
          (id) => store.get(id),
          { concurrency: "unbounded" }
        )
        assert.isTrue(stored.every(Option.isSome))
        assert.isTrue(
          stored.every(
            (intent) =>
              Option.isSome(intent) && intent.value.status === "accepted"
          )
        )
        assert.deepStrictEqual(
          stored.map((intent) =>
            Option.isSome(intent) ? intent.value.deliveryId : undefined
          ),
          ids
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeliveryStoreSql.layerSql({ tableName: deliveryTable }),
            Submissions.layerFactorySql({
              tableName: queueTable
            })
          ).pipe(
            Layer.provideMerge(
              PgClient.layer({
                url: Redacted.make(url ?? "")
              })
            )
          )
        )
      )
  )
})
