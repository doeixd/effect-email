import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema
} from "effect"
import type { DeliveryId, RouteName, TenantId } from "./Ids"
import {
  DeliveryId as DeliveryIdSchema,
  newDeliveryId,
  ProviderMessageId as ProviderMessageIdSchema
} from "./Ids"
import type { EmailError } from "./EmailError"
import { IdempotencyConflict, StoreUnavailable } from "./EmailError"
import type { MailboxInput, MessageDraft, MessageInput } from "./Message"
import type { SubmissionReceipt } from "./Submission"

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
  providerMessageId: Schema.optionalKey(ProviderMessageIdSchema),
  type: DeliveryEventType,
  occurredAt: Schema.DateTimeUtc,
  payload: Schema.optionalKey(Schema.Json)
})
export type DeliveryEvent = typeof DeliveryEvent.Type

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
    dispatchGeneration: number
  ) => Effect.Effect<DeliveryIntent, StoreUnavailable>
  readonly recordAccepted: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    receipt: SubmissionReceipt
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordRejected: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordUncertain: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordFailed: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError
  ) => Effect.Effect<void, StoreUnavailable>
  readonly recordDeferred: (
    deliveryId: DeliveryId,
    dispatchGeneration: number,
    error: EmailError,
    delayMillis: number
  ) => Effect.Effect<void, StoreUnavailable>
  readonly markQueued: (
    deliveryId: DeliveryId,
    dispatchGeneration: number
  ) => Effect.Effect<void, StoreUnavailable>
  readonly requestCancellation: (
    deliveryId: DeliveryId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly isCancellationRequested: (
    deliveryId: DeliveryId
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly redrive: (
    deliveryId: DeliveryId
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
  readonly appendProviderEvent: (
    event: DeliveryEvent
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly listEvents: (
    deliveryId?: DeliveryId
  ) => Effect.Effect<ReadonlyArray<DeliveryEvent>, StoreUnavailable>
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

const canonical = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return Array.from(value)
  }
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  }
  return value
}

const fingerprintOf = (input: CreateDeliveryIntent): string =>
  JSON.stringify(
    canonical({
      message: input.message,
      defaultFrom: input.defaultFrom,
      route: input.route ?? null
    })
  )

const missing = (deliveryId: DeliveryId): StoreUnavailable =>
  new StoreUnavailable({
    message: `delivery intent not found: ${deliveryId}`
  })

const stale = (deliveryId: DeliveryId, generation: number): StoreUnavailable =>
  new StoreUnavailable({
    message: `stale dispatch generation ${generation} for ${deliveryId}`
  })

type BeginResult =
  | { readonly _tag: "ok"; readonly intent: DeliveryIntent }
  | StoreUnavailable

type RedriveResult =
  | { readonly _tag: "ok"; readonly intent: DeliveryIntent }
  | StoreUnavailable

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

    const get: DeliveryStoreShape["get"] = (deliveryId) =>
      Effect.map(Ref.get(state), (intents) =>
        Option.fromNullishOr(intents.get(deliveryId))
      )

    const createIntent: DeliveryStoreShape["createIntent"] = (input) =>
      Effect.gen(function* () {
        const deliveryId = input.deliveryId ?? newDeliveryId()
        const dispatchGeneration = input.dispatchGeneration ?? 1
        const fingerprint = fingerprintOf(input)
        const existing = (yield* Ref.get(state)).get(deliveryId)
        if (existing !== undefined) {
          if (existing.fingerprint === fingerprint) {
            return existing
          }
          return yield* new IdempotencyConflict({
            message: `delivery ${deliveryId} already exists with different content`,
            provider: "delivery-store",
            idempotencyKey: deliveryId
          })
        }
        const now = yield* DateTime.now
        const cancellationRequested = (
          yield* Ref.get(cancellations)
        ).has(deliveryId)
        const intent: DeliveryIntent = {
          deliveryId,
          ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
          dispatchGeneration,
          message: input.message,
          defaultFrom: input.defaultFrom,
          ...(input.route === undefined ? {} : { route: input.route }),
          providerIdempotencyKey:
            input.providerIdempotencyKey ?? deliveryId,
          ...(input.rawEnvelope === undefined
            ? {}
            : { rawEnvelope: input.rawEnvelope }),
          fingerprint,
          status: "pending",
          attempts: 0,
          cancellationRequested,
          createdAt: now,
          updatedAt: now
        }
        yield* Ref.update(state, (intents) => {
          const next = new Map(intents)
          next.set(deliveryId, intent)
          return next
        })
        return intent
      })

    const update = (
      deliveryId: DeliveryId,
      dispatchGeneration: number,
      change: (intent: DeliveryIntent, now: DateTime.Utc) => DeliveryIntent
    ): Effect.Effect<void, StoreUnavailable> =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* Ref.modify(state, (intents) => {
          const intent = intents.get(deliveryId)
          if (intent === undefined) {
            return [missing(deliveryId), intents]
          }
          if (intent.dispatchGeneration !== dispatchGeneration) {
            return [stale(deliveryId, dispatchGeneration), intents]
          }
          const next = new Map(intents)
          next.set(deliveryId, change(intent, now))
          return [undefined, next]
        }).pipe(
          Effect.flatMap((error) =>
            error === undefined ? Effect.void : Effect.fail(error)
          )
        )
      })

    const beginAttempt: DeliveryStoreShape["beginAttempt"] = (
      deliveryId,
      dispatchGeneration
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const result = yield* Ref.modify(
          state,
          (
            intents
          ): readonly [BeginResult, ReadonlyMap<string, DeliveryIntent>] => {
            const intent = intents.get(deliveryId)
            if (intent === undefined) {
              return [missing(deliveryId), intents]
            }
            if (intent.dispatchGeneration !== dispatchGeneration) {
              return [stale(deliveryId, dispatchGeneration), intents]
            }
            const nextIntent: DeliveryIntent = {
              ...intent,
              attempts: intent.attempts + 1,
              status: "in-progress",
              updatedAt: now
            }
            const next = new Map(intents)
            next.set(deliveryId, nextIntent)
            return [{ _tag: "ok", intent: nextIntent }, next]
          }
        )
        if (result._tag === "StoreUnavailable") {
          return yield* result
        }
        return result.intent
      })

    const markQueued: DeliveryStoreShape["markQueued"] = (
      deliveryId,
      dispatchGeneration
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        queuedAt: now,
        updatedAt: now
      }))

    const recordAccepted: DeliveryStoreShape["recordAccepted"] = (
      deliveryId,
      dispatchGeneration,
      receipt
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        status: "accepted",
        receipt,
        updatedAt: now
      }))

    const recordRejected: DeliveryStoreShape["recordRejected"] = (
      deliveryId,
      dispatchGeneration,
      error
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        status: "rejected",
        error,
        updatedAt: now
      }))

    const recordUncertain: DeliveryStoreShape["recordUncertain"] = (
      deliveryId,
      dispatchGeneration,
      error
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        status: "uncertain",
        error,
        updatedAt: now
      }))

    const recordFailed: DeliveryStoreShape["recordFailed"] = (
      deliveryId,
      dispatchGeneration,
      error
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        status: "failed",
        error,
        updatedAt: now
      }))

    const recordDeferred: DeliveryStoreShape["recordDeferred"] = (
      deliveryId,
      dispatchGeneration,
      error,
      delayMillis
    ) =>
      update(deliveryId, dispatchGeneration, (intent, now) => ({
        ...intent,
        status: "pending",
        error,
        nextAttemptAt: DateTime.addDuration(
          now,
          Duration.millis(delayMillis)
        ),
        updatedAt: now
      }))

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
          next.set(deliveryId, {
            ...intent,
            cancellationRequested: true,
            updatedAt: now
          })
          return next
        })
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

    const redrive: DeliveryStoreShape["redrive"] = (deliveryId) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const result = yield* Ref.modify(
          state,
          (
            intents
          ): readonly [RedriveResult, ReadonlyMap<string, DeliveryIntent>] => {
            const intent = intents.get(deliveryId)
            if (intent === undefined) {
              return [missing(deliveryId), intents]
            }
            const {
              receipt: _receipt,
              error: _error,
              nextAttemptAt: _nextAttemptAt,
              queuedAt: _queuedAt,
              ...base
            } = intent
            const nextIntent: DeliveryIntent = {
              ...base,
              dispatchGeneration: intent.dispatchGeneration + 1,
              status: "pending",
              attempts: 0,
              cancellationRequested: false,
              updatedAt: now
            }
            const next = new Map(intents)
            next.set(deliveryId, nextIntent)
            return [{ _tag: "ok", intent: nextIntent }, next]
          }
        )
        if (result._tag === "StoreUnavailable") {
          return yield* result
        }
        yield* Ref.update(cancellations, (current) => {
          const next = new Set(current)
          next.delete(deliveryId)
          return next
        })
        return result.intent
      })

    const listByStatus = (
      status: DeliveryStatus
    ): Effect.Effect<ReadonlyArray<DeliveryIntent>, StoreUnavailable> =>
      Effect.map(Ref.get(state), (intents) =>
        [...intents.values()].filter(
          (intent) => intent.status === status
        )
      )

    const appendProviderEvent: DeliveryStoreShape["appendProviderEvent"] = (
      event
    ) =>
      Effect.gen(function* () {
        const inserted = yield* Ref.modify(events, (current) => {
          if (current.has(event.id)) {
            return [false, current]
          }
          const next = new Map(current)
          next.set(event.id, event)
          return [true, next]
        })
        if (inserted && event.deliveryId !== undefined) {
          const status = deliveryStatusForEvent(event.type)
          if (status !== undefined) {
            yield* Ref.update(state, (intents) => {
              const intent = intents.get(event.deliveryId!)
              if (intent === undefined) {
                return intents
              }
              const next = new Map(intents)
              next.set(event.deliveryId!, {
                ...intent,
                status,
                updatedAt: event.occurredAt
              })
              return next
            })
          }
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
      appendProviderEvent,
      listEvents,
      prune,
      isCancellationRequested,
      snapshot: Effect.map(
        Effect.all([
          Ref.get(state),
          Ref.get(events),
          Ref.get(cancellations)
        ]),
        ([intents, storedEvents, storedCancellations]) => ({
          intents: [...intents.values()],
          events: [...storedEvents.values()],
          cancellations: [...storedCancellations] as Array<DeliveryId>
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
          )
        )
    }
  })
)
