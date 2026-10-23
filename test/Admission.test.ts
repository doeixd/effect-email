import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { UnsupportedCapability } from "../src/EmailError"
import { deliveryId, destinationId, makeDestination, providerMessageId, tenantId } from "../src/Ids"
import * as Suppression from "../src/Suppression"
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
  it.effect("requires destination-scoped correlation before suppressing complaint recipients", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        const suppression = yield* Suppression.SuppressionStore
        const other = tenantId("other-account-tenant")
        const accountA = destinationId(makeDestination({ provider: "mock", account: "a" }))
        const accountB = destinationId(makeDestination({ provider: "mock", account: "b" }))
        const messageId = providerMessageId("account-scoped")
        for (const [id, owner, destination] of [[delivery, tenant, accountA], [deliveryId("other-account"), other, accountB]] as const) {
          yield* store.createIntent({ deliveryId: id, tenantId: owner, message: request.message, defaultFrom: "billing@example.com" })
          yield* store.beginAttempt(id, 1)
          yield* store.recordAccepted(id, 1, { provider: "mock", destinationId: destination, providerMessageId: messageId, acceptedAt: yield* DateTime.now })
        }
        yield* admission.appendProviderEvent({ id: "unscoped", provider: "mock", providerMessageId: messageId, type: "complained", occurredAt: yield* DateTime.now })
        assert.deepStrictEqual(yield* suppression.list(tenant), [])
        assert.deepStrictEqual(yield* suppression.list(other), [])
        yield* admission.appendProviderEvent({ id: "scoped", provider: "mock", destinationId: accountA, providerMessageId: messageId, type: "complained", occurredAt: yield* DateTime.now })
        assert.strictEqual((yield* suppression.list(tenant)).length, 1)
        assert.deepStrictEqual(yield* suppression.list(other), [])
      }).pipe(Effect.provide(layersFor(client).pipe(Layer.provideMerge(Suppression.layerMemory))))
    }))

  it.effect("rejects identical content admitted under another tenant's delivery id", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        yield* admission.accept(request)
        const result = yield* Effect.result(admission.accept({
          ...request,
          tenantId: tenantId("other-tenant")
        }))
        assert.strictEqual(result._tag === "Failure" && result.failure._tag, "IdempotencyConflict")
        assert.deepStrictEqual(yield* admission.listForTenant({
          tenantId: tenantId("other-tenant"), limit: 10
        }), [])
      }).pipe(Effect.provide(layersFor(client)))
    }))

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
