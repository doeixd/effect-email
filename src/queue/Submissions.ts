import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Pull,
  Schedule,
  Schema
} from "effect"
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
  RateLimited,
  RecipientSuppressed,
  StoreUnavailable
} from "../EmailError"
import type {
  CreateDeliveryIntent,
  DeliveryEvent,
  DeliveryIntent
} from "../DeliveryStore"
import { DeliveryStore } from "../DeliveryStore"
import type {
  MessageDraft,
  MessageInput,
  TemplateContent
} from "../Message"
import { parseMailbox, prepare } from "../Message"
import { SuppressionStore } from "../Suppression"
import * as Metrics from "../Metrics"
import type { RendererShape } from "../render/Template"
import type { DeliveryStatus } from "../Submission"
import { decideRetry } from "../RetryDecision"
import { Email } from "../Email"

export const SubmissionJob = Schema.Struct({
  version: Schema.Literals([1]),
  tenantId: TenantIdSchema,
  deliveryId: DeliveryIdSchema,
  dispatchGeneration: Schema.Int,
  retry: Schema.optionalKey(Schema.Natural)
})
export type SubmissionJob = typeof SubmissionJob.Type

export interface SubmissionQueueOptions {
  readonly name?: string
  readonly maxAttempts?: number
  readonly retrySchedule?: Schedule.Schedule<any, number>
}

const queueOptions = Symbol("@effect-email/SubmissionQueueOptions")
type ConfiguredQueue = PersistedQueue.PersistedQueue<SubmissionJob> & {
  readonly [queueOptions]: SubmissionQueueOptions
}

export const make = (
  options: SubmissionQueueOptions = {}
): Effect.Effect<
  PersistedQueue.PersistedQueue<SubmissionJob>,
  never,
  PersistedQueue.PersistedQueueFactory
> =>
  Effect.map(PersistedQueue.make({
    name: options.name ?? "email.submissions.v1",
    schema: SubmissionJob,
    maxAttempts: options.maxAttempts ?? 10,
    ...(options.retrySchedule === undefined
      ? {}
      : { retrySchedule: options.retrySchedule })
  }), (queue) => ({ ...queue, [queueOptions]: { ...options } }))

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
  )}:${job.dispatchGeneration}${job.retry === undefined ? "" : `:retry:${job.retry}`}`

export const offer = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  job: SubmissionJob,
  options: { readonly delayMillis?: number } = {}
): Effect.Effect<
  string,
  PersistedQueue.PersistedQueueError | Schema.SchemaError
> => queue.offer(job, {
  id: queueId(job),
  ...(options.delayMillis === undefined ? {} : { delay: options.delayMillis })
})

export const layerCleanup = PersistedQueue.layerCleanup

const retryDelayMillis = (attempts: number, schedule?: Schedule.Schedule<any, number>) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule ?? Schedule.min([
      Schedule.exponential("1 second"), Schedule.spaced("5 minutes")
    ]))
    let now = 0
    let delay = 0
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const next = yield* Pull.catchDone(step(now, attempt), () => Effect.undefined)
      if (next === undefined) break
      delay = Duration.toMillis(next[1])
      now += delay
    }
    return delay
  })

export const redrive = (
  queue: PersistedQueue.PersistedQueue<SubmissionJob>,
  job: SubmissionJob,
  options: {
    readonly acknowledgeDuplicateRisk?: boolean
    readonly actor?: string
    readonly reason?: string
  } = {}
): Effect.Effect<
  string,
  EmailError | PersistedQueue.PersistedQueueError | Schema.SchemaError,
  DeliveryStore
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const intent = yield* store.redrive(job.deliveryId, options)
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
  const template: TemplateContent | undefined =
    "content" in message
      ? message.content._tag === "template"
        ? message.content
        : undefined
      : message.template === undefined
        ? undefined
        : {
            _tag: "template",
            id: message.template.id,
            ...(message.template.version === undefined
              ? {}
              : { version: message.template.version }),
            ...(message.template.props === undefined
              ? {}
              : { props: message.template.props })
          }
  if (renderer === undefined || template === undefined) {
    return Effect.succeed(message)
  }
  return Effect.map(renderer.render(template), (rendered) => {
    if ("content" in message) {
      return { ...message, content: rendered }
    }
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
    const snapshot = yield* snapshotMessage(
      input.message,
      options.renderer
    )
    const message = yield* prepare(snapshot, {
      from: input.defaultFrom,
      ...(input.deliveryId === undefined
        ? {}
        : { deliveryId: input.deliveryId })
    })
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
  }).pipe(Effect.withSpan("Submissions.publishPending"))

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

const recipientsOf = (
  message: MessageInput | MessageDraft
): ReadonlyArray<string> => {
  if ("content" in message) {
    return [
      ...message.to,
      ...message.cc,
      ...message.bcc
    ].map((address) => address.address)
  }
  const parse = (
    value: MessageInput["to"] | undefined
  ): ReadonlyArray<string> => {
    if (value === undefined) {
      return []
    }
    const list = Array.isArray(value) ? value : [value]
    return list.flatMap((item) => {
      const parsed = parseMailbox(item)
      return parsed._tag === "ok" ? [parsed.value.address] : []
    })
  }
  return [
    ...parse(message.to),
    ...parse(message.cc),
    ...parse(message.bcc)
  ]
}

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
  options: {
    readonly maxAttempts?: number
    readonly retrySchedule?: Schedule.Schedule<any, number>
  } = {}
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
      return yield* StoreUnavailable.new({
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
        return yield* RateLimited.new({
          message: "submission is not due yet",
          provider: "submission-worker",
          retryAfterMillis: delay,
          retryable: true
        })
      }
    }

    const suppression = yield* Effect.serviceOption(SuppressionStore)
    const blocked = Option.isSome(suppression)
      ? yield* suppression.value.suppressed(
        job.tenantId,
        [
          ...new Set([
            ...recipientsOf(intent.message),
            ...(intent.rawEnvelope?.rcptTo ?? [])
          ])
        ]
      )
      : []

    const claimed = yield* store.beginAttempt(
      job.deliveryId,
      job.dispatchGeneration
    )
    if (claimed.status !== "in-progress" || claimed.claimId === undefined) {
      return
    }
    const claimId = claimed.claimId
    if (blocked.length > 0) {
      yield* store.recordFailed(
        job.deliveryId,
        job.dispatchGeneration,
        new RecipientSuppressed({
          message: `recipient is suppressed: ${blocked.join(", ")}`,
          recipients: blocked
        }),
        claimId
      )
      return
    }
    yield* Metric.update(Metrics.attempts, 1)
    const result = yield* Effect.result(
      email.send(intent.message, {
        deliveryId: intent.deliveryId,
        ...(intent.route === undefined ? {} : { route: intent.route }),
        ...(intent.rawEnvelope === undefined
          ? {}
          : { rawEnvelope: intent.rawEnvelope }),
        providerIdempotencyKey: intent.providerIdempotencyKey
      })
    )

    if (result._tag === "Success") {
      yield* Metric.update(Metrics.accepted, 1)
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
      attemptsMade: claimed.attempts,
      maxAttempts: options.maxAttempts ?? 10,
      defaultDelayMillis: 1_000
    })

    if (decision.action === "reconcile") {
      yield* Metric.update(Metrics.uncertain, 1)
      yield* store.recordUncertain(
        job.deliveryId,
        job.dispatchGeneration,
        error,
        claimId
      )
      return
    }

    if (decision.action === "retry") {
      yield* Metric.update(Metrics.retries, 1)
      const backoff = yield* retryDelayMillis(claimed.attempts, options.retrySchedule)
      yield* store.recordDeferred(
        job.deliveryId,
        job.dispatchGeneration,
        error,
        Math.max(decision.delayMillis ?? 1_000, backoff),
        claimId
      )
      return yield* error
    }

    if (certainty === "rejected") {
      yield* Metric.update(Metrics.rejected, 1)
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

    yield* Metric.update(Metrics.failures, 1)
    yield* store.recordFailed(
      job.deliveryId,
      job.dispatchGeneration,
      error,
      claimId
    )
    if (decision.reason === "exhausted") {
      return yield* error
    }
  }).pipe(Effect.withSpan("Submissions.processSubmission"))

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
        yield* store.recordUncertain(
          intent.deliveryId,
          intent.dispatchGeneration,
          DeliveryUncertain.new({
            message:
              "submission remained in-progress past the reconciliation cutoff",
            provider: "submission-worker"
          }),
          intent.claimId
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
export const deliveryStatusEvent = (
  intent: DeliveryIntent,
  status: DeliveryStatus,
  now: DateTime.Utc
): Option.Option<DeliveryEvent> => {
  const type =
    status.state === "delivered"
      ? "delivered"
      : status.state === "bounced"
        ? "bounced"
        : status.state === "complained"
          ? "complained"
          : undefined
  if (type === undefined) {
    return Option.none()
  }
  return Option.some({
    id: `reconciled_${intent.deliveryId}_${intent.dispatchGeneration}_${status.state}`,
    deliveryId: intent.deliveryId,
    dispatchGeneration: intent.dispatchGeneration,
    provider: status.provider,
    providerMessageId: status.providerMessageId,
    type,
    occurredAt: status.at ?? now
  })
}

export interface UncertainLookup {
  readonly lookup: (
    intent: DeliveryIntent
  ) => Effect.Effect<Option.Option<DeliveryEvent>, EmailError>
}

export const reconcileUncertain = (
  options: UncertainLookup & {
    readonly pageSize?: number
  }
): Effect.Effect<ReadonlyArray<DeliveryId>, StoreUnavailable, DeliveryStore> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const pageSize = Math.max(1, options.pageSize ?? 100)
    const reconciled: Array<DeliveryId> = []
    let after: DeliveryId | undefined
    while (true) {
      const page = yield* store.listUncertainPage({
        limit: pageSize,
        ...(after === undefined ? {} : { after })
      })
      for (const intent of page) {
        const result = yield* Effect.result(
          options.lookup(intent)
        )
        if (result._tag === "Failure") {
          yield* Effect.logWarning(
            "provider lookup reconciliation failed",
            result.failure
          )
          continue
        }
        if (Option.isSome(result.success)) {
          const inserted = yield* store.appendProviderEvent({
            ...result.success.value,
            deliveryId: intent.deliveryId,
            dispatchGeneration: intent.dispatchGeneration
          })
          if (inserted) {
            const current = yield* store.get(intent.deliveryId)
            if (Option.isSome(current) &&
              current.value.dispatchGeneration === intent.dispatchGeneration &&
              current.value.status !== "uncertain") {
              reconciled.push(intent.deliveryId)
            }
          }
        }
      }
      if (page.length < pageSize) {
        break
      }
      after = page[page.length - 1]!.deliveryId
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
  readonly queue?: PersistedQueue.PersistedQueue<SubmissionJob>
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
    const queue = options.queue ?? (yield* make(options))
    const configured = queueOptions in queue ? (queue as ConfiguredQueue)[queueOptions] : {}
    const maxAttempts = options.maxAttempts ?? configured.maxAttempts ?? 10
    const retrySchedule = options.retrySchedule ?? configured.retrySchedule
    const store = yield* DeliveryStore
    const concurrency = Math.max(1, options.concurrency ?? 1)
    const loop = queue
      .take((job, metadata) =>
        processSubmission(job, metadata, {
          maxAttempts,
          ...(retrySchedule === undefined ? {} : { retrySchedule })
        }).pipe(
          Effect.catch((error) => Effect.gen(function* () {
            const current = yield* store.get(job.deliveryId)
            if (
              Option.isSome(current) &&
              current.value.dispatchGeneration === job.dispatchGeneration &&
              current.value.status === "pending" &&
              !current.value.cancellationRequested &&
              current.value.nextAttemptAt !== undefined
            ) {
              const now = yield* Clock.currentTimeMillis
              // Offer before acknowledging the current job. The retry ordinal
              // deduplicates replay if the worker crashes after this offer.
              yield* offer(queue, { ...job, retry: (job.retry ?? 0) + 1 }, {
                delayMillis: Math.max(
                  0, DateTime.toEpochMillis(current.value.nextAttemptAt) - now
                )
              })
              return
            }
            return yield* error
          }))
        )
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
