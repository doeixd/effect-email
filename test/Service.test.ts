import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as Service from "../src/Service"

const tenant = tenantId("tenant_service")

describe("Service", () => {
  it.live("starts healthy scoped workers and shuts them down", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const health = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const service = yield* Service.start({
          queue,
          tenantId: tenant,
          workerConcurrency: 1,
          publisherIntervalMillis: 1_000,
          reconcilerIntervalMillis: 1_000
        })
        const health = yield* service.health
        yield* service.shutdown
        return health
      }).pipe(Effect.provide(layers), Effect.scoped)

      assert.deepStrictEqual(health, {
        publisher: true,
        worker: true,
        reconciler: true
      })
    }))
})
