import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Schedule } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import type { PersistedQueue } from "effect/persistence"
import * as Store from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { RateLimited, TransportUnavailable } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import type { PreparedEnvelope } from "../src/Submission"

const tenant = tenantId("scheduling")
const message = { to: "recipient@example.com", subject: "Scheduling", text: "Body" }
const factories = [
  ["memory", Submissions.layerFactoryMemory],
  ["SQL", Submissions.layerFactorySql({ pollInterval: "10 millis" }).pipe(
    Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
  )]
] as const

describe("Worker scheduling", () => {
  for (const [name, factory] of factories) {
    it.live(`${name}: deferred work releases the worker for ready mail`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        const ready = yield* Deferred.make<void>()
        const scheduled = yield* Deferred.make<void>()
        const store = yield* Store.DeliveryStore
        const lateId = deliveryId("late")
        const readyId = deliveryId("ready")
        yield* store.createIntent({ deliveryId: lateId, tenantId: tenant, message, defaultFrom: "sender@example.com" })
        yield* store.beginAttempt(lateId, 1)
        yield* store.recordDeferred(lateId, 1, TransportUnavailable.new({ message: "retry later" }), 60_000)
        const queue = yield* Submissions.make({ name: "custom-scheduling", maxAttempts: 1 })
        const observed = {
          ...queue,
          offer: (job: Submissions.SubmissionJob, options?: Parameters<typeof queue.offer>[1]) =>
            queue.offer(job, options).pipe(Effect.tap(() =>
              job.retry === 1 ? Deferred.succeed(scheduled, undefined) : Effect.void
            ))
        }
        yield* Submissions.offer(observed, { version: 1, tenantId: tenant, deliveryId: lateId, dispatchGeneration: 1 })
        const transport = {
          ...client.transport,
          send: (envelope: PreparedEnvelope) => client.transport.send(envelope).pipe(
            Effect.tap(() => envelope.deliveryId === readyId ? Deferred.succeed(ready, undefined) : Effect.void)
          )
        }
        const worker = yield* Submissions.runWorker({ queue: observed, concurrency: 1 }).pipe(
          Effect.provide(Email.layer({ defaultFrom: "sender@example.com", routes: { default: transport } })),
          Effect.forkScoped
        )
        yield* Deferred.await(scheduled).pipe(Effect.timeout("3 seconds"))
        yield* Submissions.submit(observed, tenant, { deliveryId: readyId, message, defaultFrom: "sender@example.com" })
        yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"))
        assert.strictEqual((yield* client.inbox.messages).length, 1)
        const pending = yield* store.get(lateId)
        assert.strictEqual(Option.isSome(pending) && pending.value.status, "pending")
        assert.strictEqual(Option.isSome(pending) && pending.value.attempts, 1)
        yield* Fiber.interrupt(worker)
      }).pipe(Effect.provide(Layer.merge(Store.layerMemory, factory)), Effect.scoped))
  }

  it.live("delayed retries retain the provider attempt budget across new queue items", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const exhausted = yield* Deferred.make<void>()
      const store = yield* Store.DeliveryStore
      const queue = yield* Submissions.make({
        name: "retry-budget", maxAttempts: 2, retrySchedule: Schedule.spaced("10 millis")
      })
      let sends = 0
      const retries: Array<number> = []
      const take = <A, E, R>(
        handle: (job: Submissions.SubmissionJob, metadata: { readonly id: string; readonly attempts: number }) => Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | PersistedQueue.PersistedQueueError, R> => queue.take(handle).pipe(
        Effect.tapError(() => Deferred.succeed(exhausted, undefined))
      )
      const observed = {
        ...queue,
        offer: (job: Submissions.SubmissionJob, options?: Parameters<typeof queue.offer>[1]) =>
          queue.offer(job, options).pipe(Effect.tap(() => Effect.sync(() => {
            if (job.retry !== undefined) retries.push(job.retry)
          }))),
        take
      }
      const transport = {
        ...client.transport,
        send: () => Effect.suspend(() => {
          sends++
          return Effect.fail(RateLimited.new({ message: "retry", retryAfterMillis: 20, retryable: true }))
        })
      }
      const worker = yield* Submissions.runWorker({ queue: observed }).pipe(
        Effect.provide(Email.layer({ defaultFrom: "sender@example.com", routes: { default: transport } })),
        Effect.forkScoped
      )
      const id = deliveryId("budget")
      yield* Submissions.submit(observed, tenant, { deliveryId: id, message, defaultFrom: "sender@example.com" })
      yield* Deferred.await(exhausted).pipe(Effect.timeout("3 seconds"))
      const stored = yield* store.get(id)
      assert.strictEqual(Option.isSome(stored) && stored.value.status, "failed")
      assert.strictEqual(Option.isSome(stored) && stored.value.attempts, 2)
      assert.strictEqual(sends, 2)
      assert.deepStrictEqual(retries, [1])
      yield* Fiber.interrupt(worker)
    }).pipe(Effect.provide(Layer.merge(Store.layerMemory, Submissions.layerFactoryMemory)), Effect.scoped))
})
