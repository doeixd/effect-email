import { DateTime, Duration } from "effect"
import type {
  CreateDeliveryIntent,
  DeliveryEvent,
  DeliveryIntent
} from "./DeliveryStore"
import { deliveryStatusForEvent } from "./DeliveryStore"
import { IdempotencyConflict, StoreUnavailable } from "./EmailError"
import type { DeliveryId } from "./Ids"

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

const transition = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  change: (intent: DeliveryIntent) => DeliveryIntent
): DeliveryIntent | StoreUnavailable =>
  intent.dispatchGeneration !== dispatchGeneration
    ? staleGeneration(intent.deliveryId, dispatchGeneration)
    : change({ ...intent, updatedAt: now })

export const beginAttempt = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    attempts: current.attempts + 1,
    status: "in-progress"
  }))

export const recordAccepted = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  receipt: DeliveryIntent["receipt"]
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    status: "accepted",
    receipt
  }))

export const recordRejected = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"]
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    status: "rejected",
    error
  }))

export const recordUncertain = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"]
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    status: "uncertain",
    error
  }))

export const recordFailed = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"]
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    status: "failed",
    error
  }))

export const recordDeferred = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc,
  error: DeliveryIntent["error"],
  delayMillis: number
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    status: "pending",
    error,
    nextAttemptAt: DateTime.addDuration(
      now,
      Duration.millis(delayMillis)
    )
  }))

export const markQueued = (
  intent: DeliveryIntent,
  dispatchGeneration: number,
  now: DateTime.Utc
): DeliveryIntent | StoreUnavailable =>
  transition(intent, dispatchGeneration, now, (current) => ({
    ...current,
    queuedAt: now
  }))

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
  now: DateTime.Utc
): DeliveryIntent => {
  const {
    receipt: _receipt,
    error: _error,
    nextAttemptAt: _nextAttemptAt,
    queuedAt: _queuedAt,
    ...base
  } = intent
  return {
    ...base,
    dispatchGeneration: intent.dispatchGeneration + 1,
    status: "pending",
    attempts: 0,
    cancellationRequested: false,
    updatedAt: now
  }
}

export const applyProviderEvent = (
  intent: DeliveryIntent,
  event: DeliveryEvent
): DeliveryIntent => {
  const status = deliveryStatusForEvent(event.type)
  return status === undefined
    ? intent
    : {
        ...intent,
        status,
        updatedAt: event.occurredAt
      }
}
