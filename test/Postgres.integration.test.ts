import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as SqlClient from "effect/sql/SqlClient"
import { DeliveryStore } from "../src/DeliveryStore"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import { StoreUnavailable } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"

const url = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`
const deliveryTable = `effect_email_delivery_${suffix}`
const queueTable = `effect_queue_${suffix}`
const tenant = tenantId("tenant_pg")
const delivery = deliveryId("dlv_pg_1")

describe("PostgreSQL integration", () => {
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
              return yield* new StoreUnavailable({
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
})
