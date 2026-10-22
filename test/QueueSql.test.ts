import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"

const tenant = tenantId("tenant_sql")
const delivery = deliveryId("dlv_sql_1")

const job: Submissions.SubmissionJob = {
  version: 1,
  tenantId: tenant,
  deliveryId: delivery,
  dispatchGeneration: 1
}

describe("SQL submission queue", () => {
  it.effect("persists and processes a queued submission", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        }),
        Submissions.layerFactorySql().pipe(
          Layer.provide(
            SqliteClient.layer({ filename: ":memory:" })
          )
        )
      )

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make({
          name: "email.submissions.sql"
        })
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          deliveryId: delivery,
          tenantId: tenant,
          message: {
            to: "sql@example.com",
            subject: "SQL queue",
            text: "Body"
          },
          defaultFrom: "billing@example.com"
        })
        yield* Submissions.offer(queue, job)
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )
        return yield* store.get(delivery)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "accepted"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))
})
