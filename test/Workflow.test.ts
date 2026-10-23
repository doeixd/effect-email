import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Layer, Option } from "effect"
import { WorkflowEngine } from "effect/workflow"
import * as DeliveryStore from "../src/DeliveryStore"
import { deliveryId, tenantId } from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import * as SubmitWorkflow from "../src/workflow/Submissions"

const tenant = tenantId("tenant_workflow")
const delivery = deliveryId("dlv_workflow_1")

describe("submission workflow", () => {
  it.effect("executes admission through the workflow engine", () =>
    Effect.gen(function* () {
      const base = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            DeliveryStore.layerMemory,
            Submissions.layerFactoryMemory
          )
        )
      )
      const workflow = SubmitWorkflow.layer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      )
      const app = workflow.pipe(Layer.provideMerge(base))

      const { receipt, stored } = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        const receipt = yield* SubmitWorkflow.SubmitEmail.execute({
          tenantId: tenant,
          deliveryId: delivery,
          message: {
            to: "workflow@example.com",
            subject: "Workflow",
            text: "Body"
          }
        })
        const stored = yield* store.get(delivery)
        return { receipt, stored }
      }).pipe(Effect.provide(app), Effect.scoped)

      assert.strictEqual(receipt.deliveryId, delivery)
      assert.isTrue(Option.isSome(stored))
      assert.isDefined(
        Option.isSome(stored) ? stored.value.queuedAt : undefined
      )
    }))

  it.live("waits for a provider event and resumes", () =>
    Effect.gen(function* () {
      const base = Layer.mergeAll(
        WorkflowEngine.layerMemory,
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory
      )
      const workflow = SubmitWorkflow.layerWaitForDeliveryEvent.pipe(
        Layer.provide(base)
      )

      const event = yield* Effect.gen(function* () {
        const fiber = yield* SubmitWorkflow.WaitForDeliveryEvent.execute({
          tenantId: tenant,
          deliveryId: delivery
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* SubmitWorkflow.completeDeliveryEvent(
          tenant,
          delivery,
          "delivered"
        )
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.provide(Layer.merge(workflow, base)),
        Effect.scoped
      )

      assert.strictEqual(event, "delivered")
    }))

  it.live("matches explicit event types before and during the wait", () =>
    Effect.gen(function* () {
      const base = Layer.mergeAll(
        WorkflowEngine.layerMemory,
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory
      )
      const workflow = SubmitWorkflow.layerWaitForDeliveryEvent.pipe(
        Layer.provide(base)
      )

      const event = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.appendProviderEvent({
          id: "evt_opened_before_wait",
          deliveryId: delivery,
          type: "opened",
          occurredAt: yield* DateTime.now
        })
        const fiber = yield* SubmitWorkflow.WaitForDeliveryEvent.execute({
          tenantId: tenant,
          deliveryId: delivery,
          types: ["delivered"]
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* SubmitWorkflow.completeDeliveryEvent(
          tenant,
          delivery,
          "delivered",
          { types: ["delivered"] }
        )
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.provide(Layer.merge(workflow, base)),
        Effect.scoped
      )

      assert.strictEqual(event, "delivered")
    }))
  it.live("uses a provider event that arrived before the wait", () =>
    Effect.gen(function* () {
      const base = Layer.mergeAll(
        WorkflowEngine.layerMemory,
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory
      )
      const workflow = SubmitWorkflow.layerWaitForDeliveryEvent.pipe(
        Layer.provide(base)
      )

      const event = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.appendProviderEvent({
          id: "evt_before_wait",
          deliveryId: delivery,
          type: "delivered",
          occurredAt: yield* DateTime.now
        })
        return yield* SubmitWorkflow.WaitForDeliveryEvent.execute({
          tenantId: tenant,
          deliveryId: delivery
        }).pipe(Effect.timeout("2 seconds"))
      }).pipe(
        Effect.provide(Layer.merge(workflow, base)),
        Effect.scoped
      )

      assert.strictEqual(event, "delivered")
    }))

  it.live("fails a typed wait completed by a non-matching event", () =>
    Effect.gen(function* () {
      const base = Layer.mergeAll(
        WorkflowEngine.layerMemory,
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory
      )
      const workflow = SubmitWorkflow.layerWaitForDeliveryEvent.pipe(
        Layer.provide(base)
      )

      const result = yield* Effect.gen(function* () {
        const fiber = yield* SubmitWorkflow.WaitForDeliveryEvent.execute({
          tenantId: tenant,
          deliveryId: delivery,
          types: ["delivered"]
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* SubmitWorkflow.completeDeliveryEvent(
          tenant,
          delivery,
          "opened",
          { types: ["delivered"] }
        )
        return yield* Effect.result(Fiber.join(fiber))
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.provide(Layer.merge(workflow, base)),
        Effect.scoped
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "StoreUnavailable"
      )
    }))
  it.live("cancels a delayed submission before admission", () =>
    Effect.gen(function* () {
      const base = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            DeliveryStore.layerMemory,
            Submissions.layerFactoryMemory
          )
        )
      )
      const workflows = Layer.mergeAll(
        SubmitWorkflow.layer,
        SubmitWorkflow.layerSubmitAfterDelay
      ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))
      const app = workflows.pipe(Layer.provideMerge(base))

      const result = yield* Effect.gen(function* () {
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        const fiber = yield* SubmitWorkflow.SubmitAfterDelay.execute({
          tenantId: tenant,
          deliveryId: delivery,
          message: {
            to: "canceled@example.com",
            subject: "Canceled",
            text: "Body"
          },
          delayMillis: 100
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* admission.cancel(delivery)
        return yield* Effect.result(Fiber.join(fiber))
      }).pipe(Effect.provide(app), Effect.scoped)

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "SubmissionCanceled"
      )
    }))

  it.live("runs a delayed submission workflow", () =>
    Effect.gen(function* () {
      const base = SubmissionAdmission.layer({
        defaultFrom: "billing@example.com"
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            DeliveryStore.layerMemory,
            Submissions.layerFactoryMemory
          )
        )
      )
      const workflows = Layer.mergeAll(
        SubmitWorkflow.layer,
        SubmitWorkflow.layerSubmitAfterDelay
      ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))
      const app = workflows.pipe(Layer.provideMerge(base))

      const { receipt, stored } = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        const receipt =
          yield* SubmitWorkflow.SubmitAfterDelay.execute({
            tenantId: tenant,
            deliveryId: delivery,
            message: {
              to: "delayed@example.com",
              subject: "Delayed",
              text: "Body"
            },
            delayMillis: 1
          })
        const stored = yield* store.get(delivery)
        return { receipt, stored }
      }).pipe(Effect.provide(app), Effect.scoped)

      assert.strictEqual(receipt.deliveryId, delivery)
      assert.isTrue(Option.isSome(stored))
    }))
})
