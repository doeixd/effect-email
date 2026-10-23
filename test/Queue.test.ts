import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import {
  InvalidMessage,
  StoreUnavailable,
  TransportUnavailable,
  UnsupportedCapability
} from "../src/EmailError"
import type { TransportError } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"
import * as Mock from "../src/providers/Mock"
import * as Template from "../src/render/Template"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const tenant = tenantId("tenant_1")
const delivery = deliveryId("dlv_queue_1")

const job = (dispatchGeneration = 1): Submissions.SubmissionJob => ({
  version: 1,
  tenantId: tenant,
  deliveryId: delivery,
  dispatchGeneration
})

const intentInput = {
  deliveryId: delivery,
  message: {
    to: "queued@example.com",
    subject: "Queued",
    text: "Queued body"
  },
  defaultFrom: "billing@example.com"
} as const

describe("Submission queue", () => {
  it.effect("derives collision-resistant queue ids", () =>
    Effect.sync(() => {
      assert.notStrictEqual(
        Submissions.queueId({
          version: 1,
          tenantId: tenantId("a:b"),
          deliveryId: deliveryId("c"),
          dispatchGeneration: 1
        }),
        Submissions.queueId({
          version: 1,
          tenantId: tenantId("a"),
          deliveryId: deliveryId("b:c"),
          dispatchGeneration: 1
        })
      )
    }))

  it.effect("offers one job and records provider acceptance", () =>
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

      const firstId = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        const value = job()

        yield* store.createIntent(intentInput)
        const firstId = yield* Submissions.offer(queue, value)
        const secondId = yield* Submissions.offer(queue, value)

        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )

        const stored = yield* store.get(delivery)
        assert.strictEqual(firstId, secondId)
        assert.isTrue(Option.isSome(stored))
        assert.strictEqual(
          Option.isSome(stored) && stored.value.status,
          "accepted"
        )
        assert.strictEqual(
          Option.isSome(stored) && stored.value.attempts,
          1
        )
        return firstId
      }).pipe(Effect.provide(layers))

      assert.strictEqual(firstId, Submissions.queueId(job()))
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))

  it.effect("records uncertainty and acknowledges the queue item", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [{ type: "uncertain" }]
      })
      const target = deliveryId("dlv_queue_uncertain")
      const value: Submissions.SubmissionJob = {
        version: 1,
        tenantId: tenant,
        deliveryId: target,
        dispatchGeneration: 1
      }
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: recorder.transport }
        })
      )

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          deliveryId: target
        })
        yield* Submissions.offer(queue, value)
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )
        return yield* store.get(target)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "uncertain"
      )
      assert.strictEqual((yield* recorder.attempts).length, 1)
    }))

  it.effect("does not send a canceled intent", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const target = deliveryId("dlv_queue_canceled")
      const value: Submissions.SubmissionJob = {
        version: 1,
        tenantId: tenant,
        deliveryId: target,
        dispatchGeneration: 1
      }
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          deliveryId: target
        })
        yield* store.requestCancellation(target)
        yield* Submissions.offer(queue, value)
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )
        return yield* store.get(target)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.isTrue(
        Option.isSome(stored) && stored.value.cancellationRequested
      )
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("waits for the persisted next attempt time", () =>
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

      yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        const value = job()
        yield* store.createIntent(intentInput)
        yield* store.beginAttempt(delivery, 1)
        yield* store.recordDeferred(
          delivery,
          1,
          new TransportUnavailable({
            message: "try later",
            provider: "mock",
            retryable: true
          }),
          1_000
        )
        yield* Submissions.offer(queue, value)

        const fiber = yield* queue
          .take((submission, metadata) =>
            Submissions.processSubmission(submission, metadata)
          )
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        assert.strictEqual((yield* client.inbox.messages).length, 0)

        yield* TestClock.adjust(1_000)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layers))

      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))

  it.effect("redrives under a new dispatch generation", () =>
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

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        const value = job()
        yield* store.createIntent(intentInput)
        yield* Submissions.offer(queue, value)
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )

        const redriveId = yield* Submissions.redrive(queue, value)
        assert.strictEqual(
          redriveId,
          `${tenant}:${delivery}:2`
        )
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )
        return yield* store.get(delivery)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.dispatchGeneration,
        2
      )
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "accepted"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 2)
    }))

  it.effect("marks the intent failed when the queue exhausts attempts", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        fail: { code: "NETWORK" }
      })
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const { stored, failed } = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make({ maxAttempts: 1 })
        const store = yield* DeliveryStore.DeliveryStore
        const value = job()
        yield* store.createIntent(intentInput)
        yield* Submissions.offer(queue, value)
        const result = yield* Effect.result(
          queue.take((submission, metadata) =>
            Submissions.processSubmission(submission, metadata, {
              maxAttempts: 1
            })
          )
        )
        assert.strictEqual(
          result._tag === "Failure" && result.failure._tag,
          "TransportUnavailable"
        )
        return {
          stored: yield* store.get(delivery),
          failed: yield* store.listFailed
        }
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "failed"
      )
      assert.strictEqual(failed.length, 1)
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("fails invalid messages without consuming more attempts", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const transport = {
        ...client.transport,
        send: () =>
          Effect.fail(
            new InvalidMessage({
              message: "invalid message"
            }) as unknown as TransportError
          )
      }
      const target = deliveryId("dlv_queue_invalid")
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: transport }
        })
      )

      const { stored, failed, result } = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make({ maxAttempts: 3 })
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          deliveryId: target
        })
        yield* Submissions.offer(queue, {
          version: 1,
          tenantId: tenant,
          deliveryId: target,
          dispatchGeneration: 1
        })
        const result = yield* Effect.result(
          queue.take((submission, metadata) =>
            Submissions.processSubmission(submission, metadata, {
              maxAttempts: 3
            })
          )
        )
        return {
          stored: yield* store.get(target),
          failed: yield* store.listFailed,
          result
        }
      }).pipe(Effect.provide(layers))

      assert.strictEqual(result._tag, "Success")
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "failed"
      )
      assert.strictEqual(
        Option.isSome(stored) && stored.value.attempts,
        1
      )
      assert.strictEqual(failed.length, 1)
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("fails unsupported capabilities without consuming more attempts", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const transport = {
        ...client.transport,
        send: () =>
          Effect.fail(
            new UnsupportedCapability({
              message: "attachments unsupported",
              capability: "attachments"
            }) as unknown as TransportError
          )
      }
      const target = deliveryId("dlv_queue_unsupported")
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: transport }
        })
      )

      const { stored, result } = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make({ maxAttempts: 3 })
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          deliveryId: target
        })
        yield* Submissions.offer(queue, {
          version: 1,
          tenantId: tenant,
          deliveryId: target,
          dispatchGeneration: 1
        })
        const result = yield* Effect.result(
          queue.take((submission, metadata) =>
            Submissions.processSubmission(submission, metadata, {
              maxAttempts: 3
            })
          )
        )
        return { stored: yield* store.get(target), result }
      }).pipe(Effect.provide(layers))

      assert.strictEqual(result._tag, "Success")
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "failed"
      )
      assert.strictEqual(
        Option.isSome(stored) && stored.value.attempts,
        1
      )
    }))

  it.effect("submits an intent and marks it queued", () =>
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

      const { admission, stored } = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        const admission = yield* Submissions.submit(
          queue,
          tenant,
          intentInput
        )
        const stored = yield* store.get(delivery)
        return { admission, stored }
      }).pipe(Effect.provide(layers))

      assert.strictEqual(
        admission.queueId,
        `${tenant}:${delivery}:1`
      )
      assert.isTrue(Option.isSome(stored))
      assert.isDefined(
        Option.isSome(stored) ? stored.value.queuedAt : undefined
      )
    }))

  it.effect("publishes an intent that was not queued", () =>
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

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          tenantId: tenant
        })
        const published = yield* Submissions.publishPending(queue, tenant)
        assert.deepStrictEqual(published, [
          `${tenant}:${delivery}:1`
        ])
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

  it.effect("publishes unqueued intents in bounded pages", () =>
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
      const ids = [
        deliveryId("dlv_page_1"),
        deliveryId("dlv_page_2"),
        deliveryId("dlv_page_3")
      ]

      const published = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        for (const id of ids) {
          yield* store.createIntent({
            ...intentInput,
            deliveryId: id,
            tenantId: tenant
          })
        }
        return yield* Submissions.publishPending(queue, tenant, {
          pageSize: 2
        })
      }).pipe(Effect.provide(layers))

      assert.strictEqual(published.length, 3)
    }))

  it.effect("reconciles stale intents in bounded pages", () =>
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
      const ids = [
        deliveryId("dlv_stale_page_1"),
        deliveryId("dlv_stale_page_2")
      ]

      const reconciled = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        for (const id of ids) {
          yield* store.createIntent({
            ...intentInput,
            deliveryId: id,
            tenantId: tenant
          })
          yield* store.beginAttempt(id, 1)
        }
        yield* TestClock.adjust(60_000)
        return yield* Submissions.reconcileStale({
          staleAfterMillis: 30_000,
          pageSize: 1
        })
      }).pipe(Effect.provide(layers))

      assert.deepStrictEqual(reconciled, ids)
    }))
  it.effect("publishes only the requested tenant's intents", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const otherTenant = tenantId("tenant_2")
      const otherDelivery = deliveryId("dlv_queue_other")
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const result = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          tenantId: tenant
        })
        yield* store.createIntent({
          ...intentInput,
          deliveryId: otherDelivery,
          tenantId: otherTenant
        })
        const published = yield* Submissions.publishPending(queue, tenant)
        return {
          published,
          other: yield* store.get(otherDelivery)
        }
      }).pipe(Effect.provide(layers))

      assert.deepStrictEqual(result.published, [
        `${tenant}:${delivery}:1`
      ])
      assert.isTrue(Option.isSome(result.other))
      assert.isUndefined(
        Option.isSome(result.other)
          ? result.other.value.queuedAt
          : "missing"
      )
    }))

  it.effect("acknowledges provider acceptance when outcome persistence fails", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const baseStore = DeliveryStore.layerMemory
      const failingStore = Layer.effect(
        DeliveryStore.DeliveryStore,
        Effect.map(DeliveryStore.DeliveryStore, (store) => ({
          ...store,
          recordAccepted: () =>
            Effect.fail(
              new StoreUnavailable({
                message: "outcome store unavailable"
              })
            )
        }))
      ).pipe(Layer.provide(baseStore))
      const layers = Layer.mergeAll(
        failingStore,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const result = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          tenantId: tenant
        })
        yield* Submissions.offer(queue, job())
        const processed = yield* Effect.result(
          queue.take((submission, metadata) =>
            Submissions.processSubmission(submission, metadata)
          )
        )
        return {
          processed,
          stored: yield* store.get(delivery)
        }
      }).pipe(Effect.provide(layers))

      assert.strictEqual(result.processed._tag, "Success")
      assert.strictEqual(
        Option.isSome(result.stored) && result.stored.value.status,
        "in-progress"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))

  it.effect("reconciles stale in-progress intents to uncertain", () =>
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

      const stored = yield* Effect.gen(function* () {
        const store = yield* DeliveryStore.DeliveryStore
        yield* store.createIntent({
          ...intentInput,
          tenantId: tenant
        })
        yield* store.beginAttempt(delivery, 1)
        yield* TestClock.adjust(60_000)
        const reconciled = yield* Submissions.reconcileStale({
          staleAfterMillis: 30_000
        })
        assert.deepStrictEqual(reconciled, [delivery])
        return yield* store.get(delivery)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(
        Option.isSome(stored) && stored.value.status,
        "uncertain"
      )
    }))

  it.effect("snapshots rendered content at submission time", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make([
        {
          id: "snapshot",
          version: "1",
          props: Schema.Struct({ name: Schema.String }),
          render: (props) =>
            Effect.succeed({ text: `Snapshot ${props.name}` })
        }
      ])
      const target = deliveryId("dlv_queue_snapshot")
      const layers = Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )

      const stored = yield* Effect.gen(function* () {
        const queue = yield* Submissions.make()
        const store = yield* DeliveryStore.DeliveryStore
        yield* Submissions.submit(
          queue,
          tenant,
          {
            deliveryId: target,
            defaultFrom: "billing@example.com",
            message: {
              to: "snapshot@example.com",
              subject: "Snapshot",
              template: {
                id: "snapshot",
                version: "1",
                props: { name: "Ada" }
              }
            }
          },
          { renderer }
        )
        yield* queue.take((submission, metadata) =>
          Submissions.processSubmission(submission, metadata)
        )
        return yield* store.get(target)
      }).pipe(Effect.provide(layers))

      assert.isTrue(Option.isSome(stored))
      const message = Option.isSome(stored)
        ? stored.value.message
        : undefined
      const text =
        message === undefined
          ? undefined
          : "text" in message
            ? message.text
            : "content" in message &&
                message.content._tag === "rendered"
              ? message.content.text
              : undefined
      assert.strictEqual(text, "Snapshot Ada")
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))
})
