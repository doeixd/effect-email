import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
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
      const dispatched = yield* Deferred.make<void>()
      const transport = {
        ...client.transport,
        send: (envelope: import("../src/Submission").PreparedEnvelope) =>
          client.transport.send(envelope).pipe(Effect.tap(() => Deferred.succeed(dispatched, undefined)))
      }
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: transport }
        })
      )

      const health = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make({ name: "custom-service-queue" })
        const service = yield* Service.start({
          queue,
          tenantId: tenant,
          workerConcurrency: 1,
          publisherIntervalMillis: 1_000,
          reconcilerIntervalMillis: 1_000
        })
        const health = yield* service.health
        yield* Submissions.submit(queue, tenant, {
          message: { to: "user@example.com", subject: "Custom queue", text: "Body" },
          defaultFrom: "billing@example.com"
        })
        yield* Deferred.await(dispatched).pipe(Effect.timeout("2 seconds"))
        assert.strictEqual((yield* client.inbox.messages).length, 1)
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
