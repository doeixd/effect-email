import { Clock, DateTime, Effect, Layer, Option, Schedule, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import type { DeliveryId, TenantId } from "../Ids"
import {
  DeliveryId as DeliveryIdSchema,
  TenantId as TenantIdSchema
} from "../Ids"
import type { EmailError } from "../EmailError"
import {
  certaintyOf,
  DeliveryUncertain,
  StoreUnavailable
} from "../EmailError"
import type { CreateDeliveryIntent } from "../DeliveryStore"
import { DeliveryStore } from "../DeliveryStore"
import type {
  MessageDraft,
  MessageInput,
  TemplateContent
} from "../Message"
import type { RendererShape } from "../render/Template"
import { decideRetry } from "../RetryDecision"
import { Email } from "../Email"

export const SubmissionJob = Schema.Struct({
  version: Schema.Literals([1]),
  tenantId: TenantIdSchema,
  deliveryId: DeliveryIdSchema,
  dispatchGeneration: Schema.Int
})
export type SubmissionJob = typeof SubmissionJob.Type

export interface SubmissionQueueOptions {
  readonly name?: string
  readonly maxAttempts?: number
  readonly retrySchedule?: Schedule.Schedule<any, number>
}

export const make = (
  options: SubmissionQueueOptions = {}
): Effect.Effect<
  PersistedQueue.PersistedQueue<SubmissionJob>,
  never,
  PersistedQueue.PersistedQueueFactory
> =>
  PersistedQueue.make({
    name: options.name ?? "email.submissions.v1",
    schema: SubmissionJob,
    maxAttempts: options.maxAttempts ?? 10,
    ...(options.retrySchedule === undefined
      ? {}
      : { retrySchedule: options.retrySchedule })
  })

export const layerFactoryMemory: Layer.Layer<
  PersistedQueue.PersistedQueueFactory
> = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
)

export const layerFactorySql = (
  options?: Parameters<typeof PersistedQueue.layerStoreSql>[0]
): Layer.Layer<
  PersistedQueue.PersistedQueueFactory,
  import("effect/sql/SqlError").SqlError,
  import("effect/sql/SqlClient").SqlClient
> =>
  PersistedQueue.layer.pipe(
    Layer.provide(PersistedQueue.layerStoreSql(options))
  )

export const queueId = (job: SubmissionJob): string =>
  `${encodeURIComponent(job.tenantId)}:${encodeURIComponent(
    job.deliveryId
  )}:${job.dispatchGeneration}`

export const offer = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  job: SubmissionJob
): Effect.Effect<
  string,
  PersistedQueue.PersistedQueueError | Schema.SchemaError
> => queue.offer(job, { id: queueId(job) })

export const layerCleanup = PersistedQueue.layerCleanup

export const redrive = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  job: SubmissionJob
): Effect.Effect<
  string,
  EmailError | PersistedQueue.PersistedQueueError | Schema.SchemaError,
  DeliveryStore
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const intent = yield* store.redrive(job.deliveryId)
    return yield* offer(queue, {
      version: 1,
      tenantId: job.tenantId,
      deliveryId: intent.deliveryId,
      dispatchGeneration: intent.dispatchGeneration
    })
  })

const snapshotMessage = (
  message: MessageInput | MessageDraft,
  renderer: RendererShape | undefined
): Effect.Effect<MessageInput | MessageDraft, EmailError> => {
  if (
    renderer === undefined ||
    !("template" in message) ||
    message.template === undefined
  ) {
    return Effect.succeed(message)
  }
  const template = message.template
  const content: TemplateContent = {
    _tag: "template",
    id: template.id,
    ...(template.version === undefined
      ? {}
      : { version: template.version }),
    ...(template.props === undefined ? {} : { props: template.props })
  }
  return Effect.map(renderer.render(content), (rendered) => {
    const { template: _template, ...rest } = message
    return {
      ...rest,
      ...(rendered.text === undefined ? {} : { text: rendered.text }),
      ...(rendered.html === undefined ? {} : { html: rendered.html })
    }
  })
}

export interface Admission {
  readonly deliveryId: DeliveryId
  readonly queueId: string
  readonly dispatchGeneration: number
}

export const submit = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  tenantId: TenantId,
  input: CreateDeliveryIntent,
  options: { readonly renderer?: RendererShape } = {}
): Effect.Effect<
  Admission,
  EmailError | PersistedQueue.PersistedQueueError | Schema.SchemaError,
  DeliveryStore
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const message = yield* snapshotMessage(input.message, options.renderer)
    const intent = yield* store.createIntent({
      ...input,
      tenantId,
      message
    })
    const job: SubmissionJob = {
      version: 1,
      tenantId,
      deliveryId: intent.deliveryId,
      dispatchGeneration: intent.dispatchGeneration
    }
    const id = yield* offer(queue, job)
    yield* store.markQueued(
      intent.deliveryId,
      intent.dispatchGeneration
    )
    return {
      deliveryId: intent.deliveryId,
      queueId: id,
      dispatchGeneration: intent.dispatchGeneration
    }
  })

export const publishPending = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  tenantId: TenantId,
  options: { readonly pageSize?: number } = {}
): Effect.Effect<
  ReadonlyArray<string>,
  EmailError | PersistedQueue.PersistedQueueError | Schema.SchemaError,
  DeliveryStore
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const pageSize = Math.max(1, options.pageSize ?? 100)
    const ids: Array<string> = []
    let after: DeliveryId | undefined
    while (true) {
      const pending = yield* store.listUnqueuedForTenant({
        tenantId,
        limit: pageSize,
        ...(after === undefined ? {} : { after })
      })
      for (const intent of pending) {
        const id = yield* offer(queue, {
          version: 1,
          tenantId,
          deliveryId: intent.deliveryId,
          dispatchGeneration: intent.dispatchGeneration
        })
        yield* store.markQueued(
          intent.deliveryId,
          intent.dispatchGeneration
        )
        ids.push(id)
      }
      if (pending.length < pageSize) {
        break
      }
      after = pending[pending.length - 1]!.deliveryId
    }
    return ids
  })

export const runPublisher = (options: {
  readonly queue: PersistedQueue.PersistedQueue<SubmissionJob>
  readonly tenantId: TenantId
  readonly intervalMillis?: number
  readonly pageSize?: number
}): Effect.Effect<never, never, DeliveryStore> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* publishPending(options.queue, options.tenantId, {
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: options.pageSize })
      }).pipe(
        Effect.tapError(() =>
          Effect.logWarning("submission outbox publish failed")
        ),
        Effect.ignore
      )
      yield* Effect.sleep(options.intervalMillis ?? 5_000)
    })
  )

const terminal = (
  status:
    | "pending"
    | "in-progress"
    | "accepted"
    | "rejected"
    | "uncertain"
    | "failed"
    | "canceled"
    | "delivered"
    | "bounced"
    | "complained"
): boolean =>
  status === "accepted" ||
  status === "rejected" ||
  status === "uncertain" ||
  status === "failed" ||
  status === "canceled" ||
  status === "delivered" ||
  status === "bounced" ||
  status === "complained"

export const processSubmission = (
  job: SubmissionJob,
  metadata: { readonly id: string; readonly attempts: number },
  options: { readonly maxAttempts?: number } = {}
): Effect.Effect<void, EmailError, DeliveryStore | Email> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const email = yield* Email
    yield* Effect.annotateCurrentSpan({
      deliveryId: job.deliveryId,
      dispatchGeneration: job.dispatchGeneration,
      queueAttempt: metadata.attempts
    })

    const stored = yield* store.get(job.deliveryId)
    if (Option.isNone(stored)) {
      return yield* new StoreUnavailable({
        message: `delivery intent not found: ${job.deliveryId}`
      })
    }
    const intent = stored.value
    if (intent.dispatchGeneration !== job.dispatchGeneration) {
      return
    }
    if (terminal(intent.status) || intent.cancellationRequested) {
      return
    }

    if (intent.nextAttemptAt !== undefined) {
      const now = yield* Clock.currentTimeMillis
      const delay =
        DateTime.toEpochMillis(intent.nextAttemptAt) - now
      if (delay > 0) {
        yield* Effect.sleep(delay)
      }
      const refreshed = yield* store.get(job.deliveryId)
      if (Option.isNone(refreshed)) {
        return yield* new StoreUnavailable({
          message: `delivery intent not found: ${job.deliveryId}`
        })
      }
      if (
        refreshed.value.dispatchGeneration !== job.dispatchGeneration ||
        terminal(refreshed.value.status) ||
        refreshed.value.cancellationRequested
      ) {
        return
      }
    }

    const claimed = yield* store.beginAttempt(
      job.deliveryId,
      job.dispatchGeneration
    )
    const claimId = claimed.claimId
    const result = yield* Effect.result(
      email.send(intent.message, {
        deliveryId: intent.deliveryId,
        ...(intent.route === undefined ? {} : { route: intent.route }),
        providerIdempotencyKey: intent.providerIdempotencyKey
      })
    )

    if (result._tag === "Success") {
      const recorded = yield* Effect.result(
        store.recordAccepted(
          job.deliveryId,
          job.dispatchGeneration,
          result.success,
          claimId
        )
      )
      if (recorded._tag === "Failure") {
        yield* Effect.logError(
          "provider accepted but delivery outcome could not be persisted; acknowledging the queue item to avoid duplicate submission",
          recorded.failure
        )
      }
      return
    }

    const error = result.failure
    const certainty = certaintyOf(error)
    const decision = decideRetry(error, {
      attemptsMade: metadata.attempts,
      maxAttempts: options.maxAttempts ?? 10,
      defaultDelayMillis: 1_000
    })

    if (decision.action === "reconcile") {
      yield* store.recordUncertain(
        job.deliveryId,
        job.dispatchGeneration,
        error,
        claimId
      )
      return
    }

    if (decision.action === "retry") {
      yield* store.recordDeferred(
        job.deliveryId,
        job.dispatchGeneration,
        error,
        decision.delayMillis ?? 1_000,
        claimId
      )
      return yield* error
    }

    if (certainty === "rejected") {
      yield* store.recordRejected(
        job.deliveryId,
        job.dispatchGeneration,
        error,
        claimId
      )
      if (decision.reason === "exhausted") {
        return yield* error
      }
      return
    }

    yield* store.recordFailed(
      job.deliveryId,
      job.dispatchGeneration,
      error,
      claimId
    )
    if (decision.reason === "exhausted") {
      return yield* error
    }
  })

export const reconcileStale = (
  options: {
    readonly staleAfterMillis?: number
    readonly now?: DateTime.Utc
    readonly pageSize?: number
  } = {}
): Effect.Effect<
  ReadonlyArray<DeliveryId>,
  EmailError,
  DeliveryStore
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const now = options.now ?? (yield* DateTime.now)
    const cutoff =
      DateTime.toEpochMillis(now) -
      (options.staleAfterMillis ?? 5 * 60 * 1000)
    const updatedBefore = DateTime.makeUnsafe(new Date(cutoff))
    const pageSize = Math.max(1, options.pageSize ?? 100)
    const reconciled: Array<DeliveryId> = []
    let after: DeliveryId | undefined
    while (true) {
      const stale = yield* store.listStaleInProgress({
        now,
        updatedBefore,
        limit: pageSize,
        ...(after === undefined ? {} : { after })
      })
      for (const intent of stale) {
        const events = yield* store.listEvents(intent.deliveryId)
        if (events.length > 0) {
          continue
        }
        yield* store.recordUncertain(
          intent.deliveryId,
          intent.dispatchGeneration,
          new DeliveryUncertain({
            message:
              "submission remained in-progress past the reconciliation cutoff",
            provider: "submission-worker"
          })
        )
        reconciled.push(intent.deliveryId)
      }
      if (stale.length < pageSize) {
        break
      }
      after = stale[stale.length - 1]!.deliveryId
    }
    return reconciled
  })
export const runReconciler = (options: {
  readonly staleAfterMillis?: number
  readonly intervalMillis?: number
  readonly pageSize?: number
} = {}): Effect.Effect<never, never, DeliveryStore> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* reconcileStale(options).pipe(
        Effect.tapError(() =>
          Effect.logWarning("stale submission reconciliation failed")
        ),
        Effect.ignore
      )
      yield* Effect.sleep(options.intervalMillis ?? 60_000)
    })
  )

export interface WorkerOptions extends SubmissionQueueOptions {
  readonly concurrency?: number
}

export const runWorker = (
  options: WorkerOptions = {}
): Effect.Effect<
  void,
  never,
  | DeliveryStore
  | Email
  | PersistedQueue.PersistedQueueFactory
> =>
  Effect.gen(function* () {
    const queue = yield* make(options)
    const concurrency = Math.max(1, options.concurrency ?? 1)
    const loop = queue
      .take((job, metadata) =>
        processSubmission(job, metadata, {
          maxAttempts: options.maxAttempts ?? 10
        })
      )
      .pipe(
        Effect.catchTag("PersistedQueueError", () =>
          Effect.flatMap(
            Effect.logWarning("submission queue unavailable"),
            () => Effect.sleep("1 second")
          )
        ),
        Effect.tapError(() =>
          Effect.logWarning("submission attempt failed")
        ),
        Effect.ignore,
        Effect.forever
      )
    yield* Effect.forEach(
      Array.from({ length: concurrency }, (_, index) => index),
      () => loop,
      { concurrency, discard: true }
    )
  })
