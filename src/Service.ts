import { Effect, Fiber, Option } from "effect"
import type { PersistedQueue } from "effect/persistence"
import type { TenantId } from "./Ids"
import { DeliveryStore } from "./DeliveryStore"
import { Email } from "./Email"
import * as Submissions from "./queue/Submissions"

export interface ServiceOptions {
  readonly queue: PersistedQueue.PersistedQueue<
    Submissions.SubmissionJob
  >
  readonly tenantId: TenantId
  /** @deprecated The worker now consumes the supplied queue directly. */
  readonly queueName?: string
  readonly workerConcurrency?: number
  readonly publisherIntervalMillis?: number
  readonly reconcilerIntervalMillis?: number
  readonly staleAfterMillis?: number
  readonly pageSize?: number
}

export interface ServiceHealth {
  readonly publisher: boolean
  readonly worker: boolean
  readonly reconciler: boolean
}

export interface ServiceHandle {
  readonly health: Effect.Effect<ServiceHealth>
  readonly shutdown: Effect.Effect<void>
}

export const start = (
  options: ServiceOptions
): Effect.Effect<
  ServiceHandle,
  never,
  | import("effect/Scope").Scope
  | DeliveryStore
  | Email
  | PersistedQueue.PersistedQueueFactory
> =>
  Effect.gen(function* () {
    const publisher = yield* Submissions.runPublisher({
      queue: options.queue,
      tenantId: options.tenantId,
      ...(options.publisherIntervalMillis === undefined
        ? {}
        : { intervalMillis: options.publisherIntervalMillis }),
      ...(options.pageSize === undefined
        ? {}
        : { pageSize: options.pageSize })
    }).pipe(Effect.forkScoped)

    const reconciler = yield* Submissions.runReconciler({
      ...(options.reconcilerIntervalMillis === undefined
        ? {}
        : { intervalMillis: options.reconcilerIntervalMillis }),
      ...(options.staleAfterMillis === undefined
        ? {}
        : { staleAfterMillis: options.staleAfterMillis }),
      ...(options.pageSize === undefined
        ? {}
        : { pageSize: options.pageSize })
    }).pipe(Effect.forkScoped)

    const worker = yield* Submissions.runWorker({
      queue: options.queue,
      ...(options.workerConcurrency === undefined
        ? {}
        : { concurrency: options.workerConcurrency })
    }).pipe(Effect.forkScoped)

    const running = (fiber: Fiber.Fiber<unknown, unknown>) =>
      Fiber.join(fiber).pipe(
        Effect.result,
        Effect.timeoutOption("10 millis"),
        Effect.map(Option.isNone)
      )

    return {
      health: Effect.gen(function* () {
        const [publisherRunning, workerRunning, reconcilerRunning] =
          yield* Effect.all(
            [
              running(publisher),
              running(worker),
              running(reconciler)
            ],
            { concurrency: "unbounded" }
          )
        return {
          publisher: publisherRunning,
          worker: workerRunning,
          reconciler: reconcilerRunning
        }
      }),
      shutdown: Effect.forEach(
        [publisher, worker, reconciler],
        (fiber) => Fiber.interrupt(fiber),
        { discard: true }
      )
    }
  })
