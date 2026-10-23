import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Ref,
  Schema
} from "effect"
import type {
  AttemptId,
  DeliveryId,
  DestinationId,
  ProviderMessageId,
  RouteName,
  TenantId
} from "./Ids"
import {
  DeliveryId as DeliveryIdSchema,
  DestinationId as DestinationIdSchema,
  newDeliveryId,
  ProviderMessageId as ProviderMessageIdSchema
} from "./Ids"
import type { EmailError } from "./EmailError"
import { IdempotencyConflict, StoreUnavailable } from "./EmailError"
import type { MailboxInput, MessageDraft, MessageInput } from "./Message"
import type { SubmissionReceipt } from "./Submission"
import * as Transitions from "./DeliveryTransitions"

export type CancellationOutcome =
  | "canceled-before-dispatch"
  | "cancellation-requested"
  | "already-submitted"
export type DeliveryStatus =
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

export const DeliveryEventType = Schema.Literals([
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unknown"
])
export type DeliveryEventType = typeof DeliveryEventType.Type

export const deliveryStatusForEvent = (
  type: DeliveryEventType
): DeliveryStatus | undefined => {
  switch (type) {
    case "delivered":
      return "delivered"
    case "bounced":
      return "bounced"
    case "complained":
      return "complained"
    case "opened":
    case "clicked":
    case "unknown":
      return undefined
  }
}

export const DeliveryEvent = Schema.Struct({
  id: Schema.NonEmptyString,
  deliveryId: Schema.optionalKey(DeliveryIdSchema),
  dispatchGeneration: Schema.optionalKey(Schema.Int),
  provider: Schema.optionalKey(Schema.NonEmptyString),
  destinationId: Schema.optionalKey(DestinationIdSchema),
  providerMessageId: Schema.optionalKey(ProviderMessageIdSchema),
  providerEventId: Schema.optionalKey(Schema.NonEmptyString),
  recipient: Schema.optionalKey(Schema.String),
  type: DeliveryEventType,
  occurredAt: Schema.DateTimeUtc,
  ingestedAt: Schema.optionalKey(Schema.DateTimeUtc),
  payload: Schema.optionalKey(Schema.Json)
})
export type DeliveryEvent = typeof DeliveryEvent.Type

export interface DeliveryStatusSummary {
  readonly status: DeliveryStatus
  readonly count: number
  readonly oldestUpdatedAt?: DateTime.Utc
}
export interface DeliveryStorePruneOptions {
  readonly intentsBefore?: DateTime.Utc
  readonly eventsBefore?: DateTime.Utc
}

export interface DeliveryStorePruneResult {
  readonly intents: number
  readonly events: number
}

export interface DeliveryStoreSnapshot {
  readonly intents: ReadonlyArray<DeliveryIntent>
  readonly events: ReadonlyArray<DeliveryEvent>
  readonly cancellations?: ReadonlyArray<DeliveryId>
  readonly eventWaits?: ReadonlyArray<DeliveryEventWait>
}

export interface DeliveryEventWait {
  readonly executionId: string
  readonly tenantId: TenantId
  readonly deliveryId: DeliveryId
  readonly types?: ReadonlyArray<DeliveryEventType>
  readonly dispatchGeneration?: number
}

export type DeliveryAttemptStatus =
  | "in-progress"
  | "accepted"
  | "rejected"
  | "uncertain"
  | "failed"
  | "deferred"

export interface RedriveRecord {
  readonly at: DateTime.Utc
  readonly previousGeneration: number
  readonly actor?: string
  readonly reason?: string
}
export interface DeliveryAttempt {
  readonly attemptId: AttemptId
  readonly deliveryId: DeliveryId
  readonly tenantId?: TenantId
  readonly dispatchGeneration: number
  readonly status: DeliveryAttemptStatus
  readonly startedAt: DateTime.Utc
  readonly updatedAt: DateTime.Utc
  readonly destinationId?: DestinationId
  readonly receipt?: SubmissionReceipt
  readonly error?: EmailError
}
export interface RawEnvelope {
  readonly mailFrom: string | null
  readonly rcptTo: ReadonlyArray<string>
}

export interface DeliveryIntent {
  readonly deliveryId: DeliveryId
  readonly tenantId?: TenantId
  readonly dispatchGeneration: number
  readonly message: MessageInput | MessageDraft
  readonly defaultFrom: MailboxInput
  readonly route?: RouteName
  readonly providerIdempotencyKey: string
  readonly rawEnvelope?: RawEnvelope
  readonly fingerprint: string
  readonly status: DeliveryStatus
  readonly attempts: number
  readonly cancellationRequested: boolean
  readonly createdAt: DateTime.Utc
  readonly updatedAt: DateTime.Utc
  readonly nextAttemptAt?: DateTime.Utc
  readonly queuedAt?: DateTime.Utc
  readonly receipt?: SubmissionReceipt
  readonly error?: EmailError
  readonly claimId?: AttemptId
  readonly claimExpiresAt?: DateTime.Utc
  readonly lastEventAt?: DateTime.Utc
  readonly attemptHistory?: ReadonlyArray<DeliveryAttempt>
  readonly redriveHistory?: ReadonlyArray<RedriveRecord>
}

export interface CreateDeliveryIntent {
  readonly deliveryId?: DeliveryId
  readonly tenantId?: TenantId
  readonly dispatchGeneration?: number
  readonly message: MessageInput | MessageDraft
  readonly defaultFrom: MailboxInput
  readonly route?: RouteName
  readonly providerIdempotencyKey?: string
  readonly rawEnvelope?: RawEnvelope
}

export interface DeliveryStoreShape {
  readonly createIntent: (
    input: CreateDeliveryIntent
  ) => Effect.Effect<DeliveryIntent, EmailError>
  readonly get: (
    deliveryId: DeliveryId
  ) => Effect.Effect<Option.Option<DeliveryIntent>, StoreUnavailable>
  readonly beginAttempt: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    options?: {
      readonly claimId?: AttemptId
      readonly leaseMillis?: number
    }
  ) => Effect.Effect<DeliveryIntent, StoreUnavailable>
  readonly recordAccepted: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    receipt: SubmissionReceipt,
    claimId?: AttemptId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordRejected: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError,
    claimId?: AttemptId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordUncertain: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError,
    claimId?: AttemptId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordFailed: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError,
    claimId?: AttemptId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordDeferred: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError,
    delayMillis: number,
    claimId?: AttemptId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly markQueued: (
    deliveryId: DeliveryId,
    dispatchGeneration: number
  ) => Effect.Effect<void, StoreUnavailable>
  readonly requestCancellation: (
    deliveryId: DeliveryId
  ) => Effect.Effect<CancellationOutcome, StoreUnavailable>
  readonly isCancellationRequested: (
    deliveryId: DeliveryId
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly redrive: (
    deliveryId: DeliveryId,
    options?: {
      readonly acknowledgeDuplicateRisk?: boolean
      readonly actor?: string
      readonly reason?: string
    }
  ) => Effect.Effect<DeliveryIntent, StoreUnavailable>
  readonly listAll: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listUncertain: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listPending: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listUnqueued: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listFailed: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listAttempts: (
    deliveryId: DeliveryId
  ) => Effect.Effect<ReadonlyArray<DeliveryAttempt>, StoreUnavailable>
  readonly findByProviderMessageId: (
    providerMessageId: ProviderMessageId,
    options?: { readonly provider?: string; readonly destinationId?: DestinationId }
  ) => Effect.Effect<Option.Option<DeliveryIntent>, StoreUnavailable>
  readonly listUnqueuedForTenant: (options: {
    readonly tenantId: TenantId
    readonly limit: number
    readonly after?: DeliveryId
  }) => Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable>
  readonly listStaleInProgress: (options: {
    readonly now: DateTime.Utc
    readonly updatedBefore: DateTime.Utc
    readonly limit: number
    readonly after?: DeliveryId
  }) => Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable>
  readonly listUncertainPage: (options: {
    readonly limit: number
    readonly after?: DeliveryId
  }) => Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable>
  readonly statusSummary: Effect.Effect<
    ReadonlyArray<DeliveryStatusSummary>,
    StoreUnavailable
  >
  readonly listForTenant: (options: {
    readonly tenantId: TenantId
    readonly status?: DeliveryStatus
    readonly limit: number
    readonly after?: DeliveryId
  }) => Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable>
  readonly appendProviderEvent: (
    event: DeliveryEvent
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly getEvent: (id: string) => Effect.Effect<Option.Option<DeliveryEvent>, StoreUnavailable>
  readonly listEvents: (
    deliveryId?: DeliveryId
  ) => Effect.Effect<ReadonlyArray<DeliveryEvent>, StoreUnavailable>
  readonly registerEventWait: (wait: DeliveryEventWait) => Effect.Effect<void, StoreUnavailable>
  readonly removeEventWait: (executionId: string) => Effect.Effect<void, StoreUnavailable>
  readonly listEventWaits: (deliveryId: DeliveryId) => Effect.Effect<ReadonlyArray<DeliveryEventWait>, StoreUnavailable>
  readonly prune: (
    options: DeliveryStorePruneOptions
  ) => Effect.Effect<DeliveryStorePruneResult, StoreUnavailable>
  readonly snapshot: Effect.Effect<
    DeliveryStoreSnapshot,
    StoreUnavailable
  >
  readonly restore: (
    snapshot: DeliveryStoreSnapshot
  ) => Effect.Effect<void, StoreUnavailable>
}

export class DeliveryStore extends Context.Service<
  DeliveryStore,
  DeliveryStoreShape
>()("@effect-email/DeliveryStore") {}

export const layerMemory: Layer.Layer<DeliveryStore> = Layer.effect(
  DeliveryStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<string, DeliveryIntent>>(
      new Map()
    )
    const events = yield* Ref.make<
      ReadonlyMap<string, DeliveryEvent>
    >(new Map())
    const cancellations = yield* Ref.make<ReadonlySet<string>>(
      new Set()
    )
    const eventWaits = yield* Ref.make<ReadonlyMap<string, DeliveryEventWait>>(new Map())

    const get: DeliveryStoreShape["get"] = (deliveryId) =>
      Effect.map(Ref.get(state), (intents) =>
        Option.fromNullishOr(intents.get(deliveryId))
      )

    const createIntent: DeliveryStoreShape["createIntent"] = (input) =>
      Effect.gen(function* () {
        const deliveryId = input.deliveryId ?? newDeliveryId()
        const now = yield* DateTime.now
        const cancellationRequested = (
          yield* Ref.get(cancellations)
        ).has(deliveryId)
        const result = yield* Ref.modify(
          state,
          (
            intents
          ): readonly [
            DeliveryIntent | IdempotencyConflict,
            ReadonlyMap<string, DeliveryIntent>
          ] => {
            const existing = intents.get(deliveryId)
            if (existing !== undefined) {
              return [
                Transitions.existingIntent(existing, input),
                intents
              ]
            }
            const intent = Transitions.createIntent(input, {
              deliveryId,
              now,
              cancellationRequested
            })
            const next = new Map(intents)
            next.set(deliveryId, intent)
            return [intent, next]
          }
        )
        if (result instanceof IdempotencyConflict) {
          return yield* result
        }
        return result
      })
    const applyTransition = (
      deliveryId: DeliveryId,
      dispatchGeneration: number,
      change: Transitions.IntentTransition
    ): Effect.Effect<DeliveryIntent, StoreUnavailable> =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const result = yield* Ref.modify(
          state,
          (
            intents
          ): readonly [
            DeliveryIntent | StoreUnavailable,
            ReadonlyMap<string, DeliveryIntent>
          ] => {
            const intent = intents.get(deliveryId)
            if (intent === undefined) {
              return [Transitions.missingIntent(deliveryId), intents]
            }
            const nextIntent = change(intent, now)
            if (nextIntent instanceof StoreUnavailable) {
              return [nextIntent, intents]
            }
            const next = new Map(intents)
            next.set(deliveryId, nextIntent)
            return [nextIntent, next]
          }
        )
        if (result instanceof StoreUnavailable) {
          return yield* result
        }
        return result
      })

    const update = (
      deliveryId: DeliveryId,
      dispatchGeneration: number,
      change: Transitions.IntentTransition
    ): Effect.Effect<void, StoreUnavailable> =>
      Effect.asVoid(
        applyTransition(deliveryId, dispatchGeneration, change)
      )

    const beginAttempt: DeliveryStoreShape["beginAttempt"] = (
      deliveryId,
      dispatchGeneration,
      options
    ) =>
      applyTransition(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.beginAttempt(
          intent,
          dispatchGeneration,
          now,
          options
        )
      )

    const markQueued: DeliveryStoreShape["markQueued"] = (
      deliveryId,
      dispatchGeneration
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.markQueued(intent, dispatchGeneration, now)
      )

    const recordAccepted: DeliveryStoreShape["recordAccepted"] = (
      deliveryId,
      dispatchGeneration,
      receipt,
      claimId
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.recordAccepted(
          intent,
          dispatchGeneration,
          now,
          receipt,
          claimId
        )
      )

    const recordRejected: DeliveryStoreShape["recordRejected"] = (
      deliveryId,
      dispatchGeneration,
      error,
      claimId
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.recordRejected(
          intent,
          dispatchGeneration,
          now,
          error,
          claimId
        )
      )

    const recordUncertain: DeliveryStoreShape["recordUncertain"] = (
      deliveryId,
      dispatchGeneration,
      error,
      claimId
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.recordUncertain(
          intent,
          dispatchGeneration,
          now,
          error,
          claimId
        )
      )

    const recordFailed: DeliveryStoreShape["recordFailed"] = (
      deliveryId,
      dispatchGeneration,
      error,
      claimId
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.recordFailed(
          intent,
          dispatchGeneration,
          now,
          error,
          claimId
        )
      )

    const recordDeferred: DeliveryStoreShape["recordDeferred"] = (
      deliveryId,
      dispatchGeneration,
      error,
      delayMillis,
      claimId
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) =>
        Transitions.recordDeferred(
          intent,
          dispatchGeneration,
          now,
          error,
          delayMillis,
          claimId
        )
      )

    const requestCancellation: DeliveryStoreShape["requestCancellation"] = (
      deliveryId
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* Ref.update(cancellations, (current) => {
          const next = new Set(current)
          next.add(deliveryId)
          return next
        })
        yield* Ref.update(state, (intents) => {
          const intent = intents.get(deliveryId)
          if (intent === undefined) {
            return intents
          }
          const next = new Map(intents)
          next.set(
            deliveryId,
            Transitions.requestCancellation(intent, now)
          )
          return next
        })
        return Transitions.cancellationOutcome(
          (yield* Ref.get(state)).get(deliveryId)
        )
      })

    const isCancellationRequested: DeliveryStoreShape["isCancellationRequested"] =
      (deliveryId) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(cancellations)).has(deliveryId)) {
            return true
          }
          const intent = (yield* Ref.get(state)).get(deliveryId)
          return intent?.cancellationRequested === true
        })

    const redrive: DeliveryStoreShape["redrive"] = (
      deliveryId,
      options
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const result = yield* Ref.modify(
          state,
          (
            intents
          ): readonly [
            DeliveryIntent | StoreUnavailable,
            ReadonlyMap<string, DeliveryIntent>
          ] => {
            const intent = intents.get(deliveryId)
            if (intent === undefined) {
              return [Transitions.missingIntent(deliveryId), intents]
            }
            const nextIntent = Transitions.redrive(intent, now, options)
            if (nextIntent instanceof StoreUnavailable) return [nextIntent, intents]
            const next = new Map(intents)
            next.set(deliveryId, nextIntent)
            return [nextIntent, next]
          }
        )
        if (result instanceof StoreUnavailable) {
          return yield* result
        }
        yield* Ref.update(cancellations, (current) => {
          const next = new Set(current)
          next.delete(deliveryId)
          return next
        })
        return result
      })
    const listByStatus = (
      status: DeliveryStatus
    ): Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable> =>
      Effect.map(Ref.get(state), (intents) =>
        [...intents.values()].filter(
          (intent) => intent.status === status
        )
      )

    const findByProviderMessageId: DeliveryStoreShape["findByProviderMessageId"] =
      (providerMessageId, options = {}) =>
        Effect.map(Ref.get(state), (intents) => {
          let latest: DeliveryIntent | undefined
          for (const intent of intents.values()) {
            if (
              intent.receipt?.providerMessageId !== providerMessageId ||
              (options.provider !== undefined && intent.receipt.provider !== options.provider) ||
              (options.destinationId !== undefined && intent.receipt.destinationId !== options.destinationId)
            ) {
              continue
            }
            if (
              latest === undefined ||
              DateTime.toEpochMillis(intent.updatedAt) >
                DateTime.toEpochMillis(latest.updatedAt)
            ) {
              latest = intent
            }
          }
          return Option.fromNullishOr(latest)
        })

    const appendProviderEvent: DeliveryStoreShape["appendProviderEvent"] = (
      event
    ) =>
      Effect.gen(function* () {
        const correlated =
          event.deliveryId === undefined &&
          event.providerMessageId !== undefined &&
          event.destinationId !== undefined
            ? yield* findByProviderMessageId(event.providerMessageId, {
                provider: event.provider, destinationId: event.destinationId
              })
            : Option.none()
        const storedEvent: DeliveryEvent = {
          ...event,
          ingestedAt: event.ingestedAt ?? (yield* DateTime.now),
          ...(event.deliveryId === undefined &&
          Option.isSome(correlated) &&
          Transitions.eventMatchesIntent(event, correlated.value)
            ? { deliveryId: correlated.value.deliveryId }
            : {})
        }
        const inserted = yield* Ref.modify(events, (current) => {
          if (current.has(storedEvent.id)) {
            return [false, current]
          }
          const next = new Map(current)
          next.set(storedEvent.id, storedEvent)
          return [true, next]
        })
        if (inserted && storedEvent.deliveryId !== undefined) {
          yield* Ref.update(state, (intents) => {
            const intent = intents.get(storedEvent.deliveryId!)
            if (
              intent === undefined ||
              !Transitions.eventMatchesIntent(storedEvent, intent)
            ) {
              return intents
            }
            const nextIntent = Transitions.applyProviderEvent(
              intent,
              storedEvent
            )
            if (nextIntent === intent) {
              return intents
            }
            const next = new Map(intents)
            next.set(storedEvent.deliveryId!, nextIntent)
            return next
          })
        }
        return inserted
      })

    const listEvents: DeliveryStoreShape["listEvents"] = (
      deliveryId
    ) =>
      Effect.map(Ref.get(events), (current) =>
        [...current.values()]
          .filter(
            (event) =>
              deliveryId === undefined ||
              event.deliveryId === deliveryId
          )
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(left.occurredAt) -
                DateTime.toEpochMillis(right.occurredAt) ||
              left.id.localeCompare(right.id)
          )
      )

    const prune: DeliveryStoreShape["prune"] = (options) =>
      Effect.gen(function* () {
        let intentCount = 0
        let eventCount = 0
        if (options.intentsBefore !== undefined) {
          const cutoff = DateTime.toEpochMillis(options.intentsBefore)
          const changed = yield* Ref.modify(state, (current) => {
            const next = new Map<string, DeliveryIntent>()
            let removed = 0
            for (const [deliveryId, intent] of current) {
              const terminal =
                intent.status === "rejected" ||
                intent.status === "failed" ||
                intent.status === "canceled" ||
                intent.status === "delivered" ||
                intent.status === "bounced" ||
                intent.status === "complained"
              if (
                terminal &&
                DateTime.toEpochMillis(intent.updatedAt) < cutoff
              ) {
                removed += 1
              } else {
                next.set(deliveryId, intent)
              }
            }
            return [removed, next]
          })
          intentCount = changed
        }
        if (options.eventsBefore !== undefined) {
          const cutoff = DateTime.toEpochMillis(options.eventsBefore)
          eventCount = yield* Ref.modify(events, (current) => {
            const next = new Map<string, DeliveryEvent>()
            let removed = 0
            for (const [eventId, event] of current) {
              if (DateTime.toEpochMillis(event.occurredAt) < cutoff) {
                removed += 1
              } else {
                next.set(eventId, event)
              }
            }
            return [removed, next]
          })
        }
        return { intents: intentCount, events: eventCount }
      })

    return {
      createIntent,
      get,
      beginAttempt,
      recordAccepted,
      recordRejected,
      recordUncertain,
      recordFailed,
      recordDeferred,
      markQueued,
      requestCancellation,
      redrive,
      listAll: Effect.map(Ref.get(state), (intents) => [
        ...intents.values()
      ]),
      listUncertain: listByStatus("uncertain"),
      listPending: listByStatus("pending"),
      listUnqueued: Effect.map(listByStatus("pending"), (intents) =>
        intents.filter((intent) => intent.queuedAt === undefined)
      ),
      listFailed: listByStatus("failed"),
      listAttempts: (deliveryId) =>
        Effect.map(
          Ref.get(state),
          (intents) =>
            intents.get(deliveryId)?.attemptHistory ?? []
        ),
      findByProviderMessageId,
      listUnqueuedForTenant: (options) =>
        Effect.map(Ref.get(state), (intents) =>
          [...intents.values()]
            .filter(
              (intent) =>
                intent.tenantId === options.tenantId &&
                intent.status === "pending" &&
                intent.queuedAt === undefined &&
                (options.after === undefined ||
                  intent.deliveryId > options.after)
            )
            .sort((left, right) =>
              left.deliveryId.localeCompare(right.deliveryId)
            )
            .slice(0, options.limit)
        ),
      statusSummary: Effect.map(Ref.get(state), (intents) => {
        const grouped = new Map<
          DeliveryStatus,
          { count: number; oldestUpdatedAt?: DateTime.Utc }
        >()
        for (const intent of intents.values()) {
          const current = grouped.get(intent.status)
          const oldest =
            current?.oldestUpdatedAt === undefined ||
            DateTime.toEpochMillis(intent.updatedAt) <
              DateTime.toEpochMillis(current.oldestUpdatedAt)
              ? intent.updatedAt
              : current.oldestUpdatedAt
          grouped.set(intent.status, {
            count: (current?.count ?? 0) + 1,
            oldestUpdatedAt: oldest
          })
        }
        return [...grouped.entries()].map(([status, value]) => ({
          status,
          count: value.count,
          ...(value.oldestUpdatedAt === undefined
            ? {}
            : { oldestUpdatedAt: value.oldestUpdatedAt })
        }))
      }),
      listUncertainPage: (options) =>
        Effect.map(Ref.get(state), (intents) =>
          [...intents.values()]
            .filter(
              (intent) =>
                intent.status === "uncertain" &&
                (options.after === undefined ||
                  intent.deliveryId > options.after)
            )
            .sort((left, right) =>
              left.deliveryId.localeCompare(right.deliveryId)
            )
            .slice(0, options.limit)
        ),
      listForTenant: (options) =>
        Effect.map(Ref.get(state), (intents) =>
          [...intents.values()]
            .filter(
              (intent) =>
                intent.tenantId === options.tenantId &&
                (options.status === undefined ||
                  intent.status === options.status) &&
                (options.after === undefined ||
                  intent.deliveryId > options.after)
            )
            .sort((left, right) =>
              left.deliveryId.localeCompare(right.deliveryId)
            )
            .slice(0, options.limit)
        ),
      listStaleInProgress: (options) =>
        Effect.map(Ref.get(state), (intents) =>
          [...intents.values()]
            .filter((intent) => {
              if (
                intent.status !== "in-progress" ||
                (options.after !== undefined &&
                  intent.deliveryId <= options.after)
              ) {
                return false
              }
              if (intent.claimExpiresAt !== undefined) {
                return (
                  DateTime.toEpochMillis(intent.claimExpiresAt) <=
                  DateTime.toEpochMillis(options.now)
                )
              }
              return (
                DateTime.toEpochMillis(intent.updatedAt) <
                DateTime.toEpochMillis(options.updatedBefore)
              )
            })
            .sort((left, right) =>
              left.deliveryId.localeCompare(right.deliveryId)
            )
            .slice(0, options.limit)
        ),
      appendProviderEvent,
      getEvent: (id) => Ref.get(events).pipe(Effect.map((current) => Option.fromNullishOr(current.get(id)))),
      listEvents,
      registerEventWait: (wait) => Ref.update(eventWaits, (current) => {
        if (current.has(wait.executionId)) return current
        return new Map(current).set(wait.executionId, wait)
      }),
      removeEventWait: (executionId) => Ref.update(eventWaits, (current) => {
        const next = new Map(current)
        next.delete(executionId)
        return next
      }),
      listEventWaits: (deliveryId) => Ref.get(eventWaits).pipe(Effect.map((current) =>
        [...current.values()].filter((wait) => wait.deliveryId === deliveryId)
      )),
      prune,
      isCancellationRequested,
      snapshot: Effect.map(
        Effect.all([
          Ref.get(state),
          Ref.get(events),
          Ref.get(cancellations),
          Ref.get(eventWaits)
        ]),
        ([intents, storedEvents, storedCancellations, waits]) => ({
          intents: [...intents.values()],
          events: [...storedEvents.values()],
          cancellations: [...storedCancellations] as Array<DeliveryId>,
          eventWaits: [...waits.values()]
        })
      ),
      restore: (snapshot) =>
        Effect.flatMap(
          Ref.set(
            state,
            new Map(
              snapshot.intents.map((intent) => [
                intent.deliveryId,
                intent
              ])
            )
          ),
          () =>
            Ref.set(
              events,
              new Map(
                snapshot.events.map((event) => [event.id, event])
              )
            )
        ).pipe(
          Effect.flatMap(() =>
            Ref.set(
              cancellations,
              new Set(snapshot.cancellations ?? [])
            )
          ),
          Effect.flatMap(() => Ref.set(eventWaits, new Map(
            (snapshot.eventWaits ?? []).map((wait) => [wait.executionId, wait])
          )))
        )
    }
  })
)
