import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { UnsupportedCapability } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"

const tenant = tenantId("tenant_admission")
const delivery = deliveryId("dlv_admission_1")

const request = {
  tenantId: tenant,
  deliveryId: delivery,
  message: {
    to: "admitted@example.com",
    subject: "Admitted",
    text: "Admitted body"
  }
} as const

const layersFor = (
  client: Mock.MockClient,
  options: Omit<SubmissionAdmission.SubmissionAdmissionOptions, "defaultFrom"> = {}
) =>
  SubmissionAdmission.layer({
    defaultFrom: "billing@example.com",
    ...options
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )
    )
  )

describe("SubmissionAdmission", () => {
  it.effect("accepts an authorized submission and queues it", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        const receipt = yield* admission.accept(request)
        const stored = yield* store.get(delivery)
        yield* admission.queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        const processed = yield* store.get(delivery)
        return { receipt, stored, processed }
      }).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(result.receipt.deliveryId, delivery)
      assert.strictEqual(
        result.receipt.gatewaySubmissionId,
        `sub_${delivery}`
      )
      assert.isTrue(Option.isSome(result.stored))
      assert.isDefined(
        Option.isSome(result.stored)
          ? result.stored.value.queuedAt
          : undefined
      )
      assert.strictEqual(
        Option.isSome(result.processed) &&
          result.processed.value.status,
        "accepted"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))

  it.effect("rejects invalid messages before queueing", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const invalid = deliveryId("dlv_admission_invalid")
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        const accepted = yield* Effect.result(
          admission.accept({
            ...request,
            deliveryId: invalid,
            message: {
              to: "not-an-email",
              subject: "Invalid",
              text: "Body"
            }
          })
        )
        return {
          accepted,
          stored: yield* store.get(invalid)
        }
      }).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(
        result.accepted._tag === "Failure" &&
          result.accepted.failure._tag,
        "InvalidMessage"
      )
      assert.isTrue(Option.isNone(result.stored))
    }))
  it.effect("denies an unauthorized submission before queueing", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        const accepted = yield* Effect.result(
          admission.accept(request)
        )
        const stored = yield* store.get(delivery)
        return { accepted, stored }
      }).pipe(
        Effect.provide(
          layersFor(client, {
            authorize: () =>
              Effect.fail(
                UnsupportedCapability.new({
                  message: "not allowed",
                  capability: "authorization"
                })
              )
          })
        )
      )

      assert.strictEqual(
        result.accepted._tag === "Failure" &&
          result.accepted.failure._tag,
        "UnsupportedCapability"
      )
      assert.isTrue(Option.isNone(result.stored))
    }))

  it.effect("cancels a pending admission", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const stored = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        yield* admission.accept(request)
        yield* admission.cancel(delivery)
        return yield* store.get(delivery)
      }).pipe(Effect.provide(layersFor(client)))

      assert.isTrue(Option.isSome(stored))
      assert.isTrue(
        Option.isSome(stored) && stored.value.cancellationRequested
      )
    }))
})
