import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/sql/SqlClient"
import { DeliveryStore } from "../src/DeliveryStore"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import { StoreUnavailable } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"

const tenant = tenantId("tenant_outbox")
const delivery = deliveryId("dlv_outbox_1")

describe("SQL transactional outbox", () => {
  it.effect("rolls back intent and queue offer together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* DeliveryStore
      const queue = yield* Submissions.make({
        name: "email.outbox.test"
      })

      const result = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* store.createIntent({
              deliveryId: delivery,
              tenantId: tenant,
              message: {
                to: "outbox@example.com",
                subject: "Outbox",
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
      const counts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_queue
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
          DeliveryStoreSql.layerSql(),
          Submissions.layerFactorySql()
        ).pipe(
          Layer.provideMerge(
            SqliteClient.layer({ filename: ":memory:" })
          )
        )
      )
    ))
})
