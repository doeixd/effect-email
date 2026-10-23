import { DateTime, Duration } from "effect"
import type {
  CancellationOutcome,
  CreateDeliveryIntent,
  DeliveryAttempt,
  DeliveryAttemptStatus,
  DeliveryEvent,
  DeliveryIntent
} from "./DeliveryStore"
import { deliveryStatusForEvent } from "./DeliveryStore"
import { IdempotencyConflict, StoreUnavailable } from "./EmailError"
import type {
  AttemptId,
  DeliveryId,
  DestinationId
} from "./Ids"
import { newAttemptId } from "./Ids"

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

export const fingerprintOf = (input: CreateDeliveryIntent): string =>
  JSON.stringify(
    canonical({
      message: input.message,
      defaultFrom: input.defaultFrom,
      route: input.route ?? null
    })
  )

export const missingIntent = (deliveryId: DeliveryId): StoreUnavailable =>
  new StoreUnavailable({
    message: `delivery intent not found: ${deliveryId}`
  })

export const staleGeneration = (
  deliveryId: DeliveryId,
  generation: number
): StoreUnavailable =>
  new StoreUnavailable({
    message: `stale dispatch generation ${generation} for ${deliveryId}`
  })

export type IntentTransition = (
  intent: DeliveryIntent,
  now: DateTime.Utc
) => DeliveryIntent | StoreUnavailable

export const createIntent = (
  input: CreateDeliveryIntent,
  options: {
    readonly deliveryId: DeliveryId
    readonly now: DateTime.Utc
    readonly cancellationRequested: boolean
  }
): DeliveryIntent => ({
  deliveryId: options.deliveryId,
  ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
  dispatchGeneration: input.dispatchGeneration ?? 1,
  message: input.message,
  defaultFrom: input.defaultFrom,
  ...(input.route === undefined ? {} : { route: input.route }),
  providerIdempotencyKey:
    input.providerIdempotencyKey ?? options.deliveryId,
  ...(input.rawEnvelope === undefined
    ? {}
    : { rawEnvelope: input.rawEnvelope }),
  fingerprint: fingerprintOf(input),
  status: "pending",
  attempts: 0,
  cancellationRequested: options.cancellationRequested,
  createdAt: options.now,
  updatedAt: options.now
})

export const existingIntent = (
  existing: DeliveryIntent,
  input: CreateDeliveryIntent
): DeliveryIntent | IdempotencyConflict =>
  existing.fingerprint === fingerprintOf(input)
    ? existing
    : new IdempotencyConflict({
        message: `delivery ${existing.deliveryId} already exists with different content`,
        provider: "delivery-store",
        idempotencyKey: existing.deliveryId
      })

const claimLost = (deliveryId: DeliveryId): StoreUnavailable =>
  new StoreUnavailable({
    message: `delivery claim was lost or superseded: ${deliveryId}`
  })

const clearClaim = (intent: DeliveryIntent): DeliveryIntent => {
  const {
    claimId: _claimId,
    claimExpiresAt: _claimExpiresAt,
    ...rest
  } = intent
  return rest
}

const updateAttempt = (
  intent: DeliveryIntent,
  claimId: AttemptId | undefined,
  status: DeliveryAttemptStatus,
  now: DateTime.Utc,
  patch: {
    readonly destinationId?: DestinationId
    readonly receipt?: DeliveryIntent["receipt"]
    readonly error?: DeliveryIntent["error"]
  } = {}
): ReadonlyArray<DeliveryAttempt> => {
  const history = intent.attemptHistory ?? []
  let index = -1
  for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
    const attempt = history[cursor]!
    if (
      claimId !== undefined
        ? attempt.attemptId === claimId
        : attempt.status === "in-progress"
    ) {
      index = cursor
      break
    }
  }
  if (index < 0) {
    return history
  }
  const next = [...history]
  next[index] = {
    ...next[index]!,
    status,
    updatedAt: now,
    ...(patch.destinationId === undefined
      ? {}
      : { destinationId: patch.destinationId }),
    ...(patch.receipt === undefined ? {} : { receipt: patch.receipt }),
    ...(patch.error === undefined ? {} : { error: patch.error })
  }
  return next
}
const transition = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  change: (intent: DeliveryIntent) => DeliveryIntent,
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  intent.dispatchGeneration !== dispatchGeneration
    ? staleGeneration(intent.deliveryId, dispatchGeneration)
    : claimId !== undefined && intent.claimId !== claimId
      ? claimLost(intent.deliveryId)
      : change({ ...clearClaim(intent), updatedAt: now })

export interface ClaimOptions {
  readonly claimId?: AttemptId
  readonly leaseMillis?: number
}

export const beginAttempt = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  options: ClaimOptions = {}
): DeliveryIntent | StoreUnavailable => {
  if (intent.dispatchGeneration !== dispatchGeneration) {
    return staleGeneration(intent.deliveryId, dispatchGeneration)
  }
  if (intent.claimExpiresAt !== undefined) {
    const expiresAt = DateTime.toEpochMillis(intent.claimExpiresAt)
    const current = DateTime.toEpochMillis(now)
    return new StoreUnavailable({
      message:
        expiresAt > current
          ? `delivery already has an active claim: ${intent.deliveryId}`
          : `delivery claim expired; reconciliation required: ${intent.deliveryId}`
    })
  }
  const claimId = options.claimId ?? newAttemptId()
  const leaseMillis = options.leaseMillis ?? 30_000
  return {
    ...intent,
    attempts: intent.attempts + 1,
    status: "in-progress",
    claimId,
    claimExpiresAt: DateTime.addDuration(
      now,
      Duration.millis(leaseMillis)
    ),
    attemptHistory: [
      ...(intent.attemptHistory ?? []),
      {
        attemptId: claimId,
        deliveryId: intent.deliveryId,
        ...(intent.tenantId === undefined
          ? {}
          : { tenantId: intent.tenantId }),
        dispatchGeneration,
        status: "in-progress",
        startedAt: now,
        updatedAt: now
      }
    ],
    updatedAt: now
  }
}

export const recordAccepted = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  receipt: DeliveryIntent["receipt"],
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  transition(
    intent,
    dispatchGeneration,
    now,
    (current) => ({
      ...current,
      status: "accepted",
      receipt,
      attemptHistory: updateAttempt(
        current,
        claimId,
        "accepted",
        now,
        {
          ...(receipt?.destinationId === undefined
            ? {}
            : { destinationId: receipt.destinationId }),
          receipt
        }
      )
    }),
    claimId
  )

export const recordRejected = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"],
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  transition(
    intent,
    dispatchGeneration,
    now,
    (current) => ({
      ...current,
      status: "rejected",
      error,
      attemptHistory: updateAttempt(
        current,
        claimId,
        "rejected",
        now,
        { error }
      )
    }),
    claimId
  )

export const recordUncertain = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"],
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  transition(
    intent,
    dispatchGeneration,
    now,
    (current) => ({
      ...current,
      status: "uncertain",
      error,
      attemptHistory: updateAttempt(
        current,
        claimId,
        "uncertain",
        now,
        { error }
      )
    }),
    claimId
  )

export const recordFailed = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"],
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  transition(
    intent,
    dispatchGeneration,
    now,
    (current) => ({
      ...current,
      status: "failed",
      error,
      attemptHistory: updateAttempt(
        current,
        claimId,
        "failed",
        now,
        { error }
      )
    }),
    claimId
  )

export const recordDeferred = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"],
  delayMillis: number,
  claimId?: AttemptId
): DeliveryIntent | StoreUnavailable =>
  transition(
    intent,
    dispatchGeneration,
    now,
    (current) => ({
      ...current,
      status: "pending",
      error,
      nextAttemptAt: DateTime.addDuration(
        now,
        Duration.millis(delayMillis)
      ),
      attemptHistory: updateAttempt(
        current,
        claimId,
        "deferred",
        now,
        { error }
      )
    }),
    claimId
  )

export const markQueued = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    queuedAt: now
  }))

export const cancellationOutcome = (
  intent: DeliveryIntent | undefined
): CancellationOutcome => {
  if (intent === undefined) {
    return "canceled-before-dispatch"
  }
  if (
    intent.status === "accepted" ||
    intent.status === "delivered" ||
    intent.status === "bounced" ||
    intent.status === "complained"
  ) {
    return "already-submitted"
  }
  if (intent.status === "in-progress" && intent.claimId !== undefined) {
    return "cancellation-requested"
  }
  return "canceled-before-dispatch"
}

export const requestCancellation = (
  intent: DeliveryIntent,
  now: DateTime.Utc
): DeliveryIntent => ({
  ...intent,
  cancellationRequested: true,
  updatedAt: now
})

export const redrive = (
  intent: DeliveryIntent,
  now: DateTime.Utc,
  options: {
    readonly actor?: string
    readonly reason?: string
  } = {}
): DeliveryIntent => {
  const {
    receipt: _receipt,
    error: _error,
    nextAttemptAt: _nextAttemptAt,
    queuedAt: _queuedAt,
    claimId: _claimId,
    claimExpiresAt: _claimExpiresAt,
    ...base
  } = intent
  return {
    ...base,
    dispatchGeneration: intent.dispatchGeneration + 1,
    status: "pending",
    attempts: 0,
    cancellationRequested: false,
    redriveHistory: [
      ...(intent.redriveHistory ?? []),
      {
        at: now,
        previousGeneration: intent.dispatchGeneration,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.reason === undefined ? {} : { reason: options.reason })
      }
    ],
    updatedAt: now
  }
}

const outcomeRank = (status: DeliveryIntent["status"]): number => {
  switch (status) {
    case "delivered":
      return 1
    case "bounced":
      return 2
    case "complained":
      return 3
    default:
      return 0
  }
}

const canProjectEvent = (
  current: DeliveryIntent["status"],
  incoming: DeliveryIntent["status"]
): boolean => {
  if (
    current === "rejected" ||
    current === "failed" ||
    current === "canceled" ||
    current === "complained"
  ) {
    return false
  }
  if (current === incoming) {
    return false
  }
  if (outcomeRank(current) === 0) {
    return true
  }
  return outcomeRank(incoming) > outcomeRank(current)
}

export const eventMatchesIntent = (
  event: DeliveryEvent,
  intent: DeliveryIntent
): boolean => {
  const receipt = intent.receipt
  if (receipt === undefined) {
    return (
      event.provider === undefined &&
      event.destinationId === undefined
    )
  }
  return (
    (event.provider === undefined ||
      event.provider === receipt.provider) &&
    (event.destinationId === undefined ||
      event.destinationId === receipt.destinationId)
  )
}

export const applyProviderEvent = (
  intent: DeliveryIntent,
  event: DeliveryEvent
): DeliveryIntent => {
  const status = deliveryStatusForEvent(event.type)
  if (status === undefined) {
    return intent
  }
  if (
    intent.lastEventAt !== undefined &&
    DateTime.toEpochMillis(event.occurredAt) <=
      DateTime.toEpochMillis(intent.lastEventAt)
  ) {
    return intent
  }
  if (!canProjectEvent(intent.status, status)) {
    return intent
  }
  return {
    ...clearClaim(intent),
    status,
    lastEventAt: event.occurredAt,
    updatedAt: event.occurredAt
  }
}
