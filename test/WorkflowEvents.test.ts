import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Layer, Option } from "effect"
import { WorkflowEngine } from "effect/workflow"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as Request from "effect/http/HttpServerRequest"
import * as Store from "../src/DeliveryStore"
import * as SqlStore from "../src/DeliveryStoreSql"
import * as Queue from "../src/queue/Submissions"
import * as Admission from "../src/SubmissionAdmission"
import * as Flow from "../src/workflow/Submissions"
import * as Gateway from "../src/server/Gateway"
import { deliveryId, providerMessageId, tenantId } from "../src/Ids"

const tenant = tenantId("events")
const id = deliveryId("event-delivery")
const stores = [
  ["memory", Store.layerMemory],
  ["SQL", SqlStore.layerSql().pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })))]
] as const
const post = (event: unknown) => Gateway.make({ authorize: () => Effect.void, verifyEvent: () => Effect.void }).pipe(
  Effect.provideService(Request.HttpServerRequest, Request.fromWeb(new globalThis.Request(`http://localhost/v1/emails/${id}/events`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event)
  })))
)

describe("Durable event subscriptions", () => {
  for (const [name, storeLayer] of stores) {
    it.live(`${name}: gateway wakes matching typed and purpose-specific waits only`, () => {
      const shared = Layer.mergeAll(storeLayer, Queue.layerFactoryMemory, WorkflowEngine.layerMemory)
      const app = Layer.merge(
        Admission.layer({ defaultFrom: "sender@example.com" }).pipe(Layer.provideMerge(shared)),
        Flow.layerWaitForDeliveryEvent.pipe(Layer.provide(shared))
      )
      return Effect.gen(function* () {
        const store = yield* Store.DeliveryStore
        const admission = yield* Admission.SubmissionAdmission
        yield* admission.accept({ tenantId: tenant, deliveryId: id, message: { to: "recipient@example.com", subject: "Events", text: "Body" } })
        // This signed-but-miscorrelated event is retained for audit, not accepted
        // as evidence about the current delivery.
        yield* store.appendProviderEvent({
          id: "invalid-bounce", deliveryId: id, providerMessageId: providerMessageId("wrong-message"),
          type: "bounced", occurredAt: yield* DateTime.now
        })
        const payload = { tenantId: tenant, deliveryId: id }
        const any = yield* Flow.WaitForDeliveryEvent.execute(payload).pipe(Effect.forkScoped)
        const typed = yield* Flow.WaitForDeliveryEvent.execute({ ...payload, types: ["delivered"] }).pipe(Effect.forkScoped)
        const purpose = yield* Flow.WaitForDeliveryEvent.execute({ ...payload, types: ["delivered"], purpose: "invoice" }).pipe(Effect.forkScoped)
        const bounce = yield* Flow.WaitForDeliveryEvent.execute({ ...payload, types: ["bounced"] }).pipe(Effect.forkScoped)
        while ((yield* store.listEventWaits(id)).length < 4) yield* Effect.sleep("1 millis")
        assert.strictEqual((yield* post({ id: "opened", type: "opened" })).status, 202)
        assert.strictEqual(yield* Fiber.join(any), "opened")
        assert.isTrue(Option.isNone(yield* Fiber.join(typed).pipe(Effect.timeoutOption("10 millis"))))
        assert.isTrue(Option.isNone(yield* Fiber.join(bounce).pipe(Effect.timeoutOption("10 millis"))))
        yield* post({ id: "opened", type: "delivered" })
        assert.isTrue(Option.isNone(yield* Fiber.join(typed).pipe(Effect.timeoutOption("10 millis"))))
        // Emulate a crash between commit and notification; replay must notify
        // even though the event is already deduplicated in the store.
        yield* store.appendProviderEvent({ id: "delivered", deliveryId: id, type: "delivered", occurredAt: yield* DateTime.now })
        assert.strictEqual((yield* post({ id: "delivered", type: "delivered" })).status, 202)
        assert.strictEqual(yield* Fiber.join(typed), "delivered")
        assert.strictEqual(yield* Fiber.join(purpose), "delivered")
        yield* Flow.interruptDeliveryEventWait(tenant, id, { types: ["bounced"] })
        assert.deepStrictEqual(yield* store.listEventWaits(id), [])
      }).pipe(Effect.provide(app), Effect.scoped, Effect.timeout("3 seconds"))
    })
  }

  it.effect("SQL registrations survive reconstruction of the delivery store", () =>
    Effect.gen(function* () {
      const wait = { executionId: "persistent-wait", tenantId: tenant, deliveryId: id, types: ["delivered"] as const }
      yield* Effect.flatMap(Store.DeliveryStore, (store) => store.registerEventWait(wait)).pipe(Effect.provide(SqlStore.layerSql()))
      const recovered = yield* Effect.flatMap(Store.DeliveryStore, (store) => store.listEventWaits(id)).pipe(Effect.provide(SqlStore.layerSql()))
      assert.deepStrictEqual(recovered, [wait])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))
})
