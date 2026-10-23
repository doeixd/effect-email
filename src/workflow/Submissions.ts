import { Duration, Effect, Exit, Option, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import {
  DurableClock,
  DurableDeferred,
  Workflow,
  WorkflowEngine
} from "effect/workflow"
import { DeliveryEventType, DeliveryStore } from "../DeliveryStore"
import {
  DeliveryId as DeliveryIdSchema,
  RouteName as RouteNameSchema,
  TenantId as TenantIdSchema
} from "../Ids"
import {
  EmailError,
  StoreUnavailable,
  SubmissionCanceled
} from "../EmailError"
import { MessageInputSchema } from "../Message"
import { AdmissionReceipt } from "../Submission"
import { SubmissionAdmission } from "../SubmissionAdmission"
import { eventMatchesIntent } from "../DeliveryTransitions"
import type { DeliveryEventWait } from "../DeliveryStore"

// The encoded key contains no colons, so it cannot collide with a legacy
// tenant:delivery key already cached by a persistent workflow engine.
const workflowKey = (parts: ReadonlyArray<unknown>) => `v2.${Base64Url.encode(JSON.stringify(parts))}`

export const SubmissionWorkflowPayload = Schema.Struct({
  tenantId: TenantIdSchema,
  deliveryId: DeliveryIdSchema,
  message: MessageInputSchema,
  route: Schema.optionalKey(RouteNameSchema),
  providerIdempotencyKey: Schema.optionalKey(Schema.String)
})
export type SubmissionWorkflowPayload =
  typeof SubmissionWorkflowPayload.Type

export const SubmitEmail = Workflow.make("SubmitEmail", {
  payload: SubmissionWorkflowPayload,
  success: AdmissionReceipt,
  error: EmailError,
  idempotencyKey: (payload) =>
    workflowKey([payload.tenantId, payload.deliveryId])
})

export const DelayedSubmissionPayload = Schema.Struct({
  ...SubmissionWorkflowPayload.fields,
  delayMillis: Schema.Natural
})
export type DelayedSubmissionPayload =
  typeof DelayedSubmissionPayload.Type

export const SubmitAfterDelay = Workflow.make("SubmitAfterDelay", {
  payload: DelayedSubmissionPayload,
  success: AdmissionReceipt,
  error: EmailError,
  idempotencyKey: (payload) =>
    workflowKey([payload.tenantId, payload.deliveryId, payload.delayMillis])
})

export const layerSubmitAfterDelay = SubmitAfterDelay.toLayer(
  (payload) =>
    Effect.gen(function* () {
      yield* DurableClock.sleep({
        name: "submission-delay",
        duration: Duration.millis(payload.delayMillis)
      })
      const admission = yield* SubmissionAdmission
      if (
        yield* admission.isCancellationRequested(payload.deliveryId)
      ) {
        return yield* new SubmissionCanceled({
          message: "delayed submission was canceled",
          deliveryId: payload.deliveryId
        })
      }
      return yield* admission.accept({
        tenantId: payload.tenantId,
        deliveryId: payload.deliveryId,
        message: payload.message,
        ...(payload.route === undefined
          ? {}
          : { route: payload.route }),
        ...(payload.providerIdempotencyKey === undefined
          ? {}
          : {
              providerIdempotencyKey:
                payload.providerIdempotencyKey
            })
      })
    })
)

export const resumeSubmission = (executionId: string) =>
  Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
    engine.resume(SubmitEmail, executionId)
  )

export const interruptSubmission = (executionId: string) =>
  Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
    engine.interrupt(SubmitEmail, executionId)
  )

export const pollSubmission = (executionId: string) =>
  Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
    engine.poll(SubmitEmail, executionId)
  )

export const interruptDelayedSubmission = (
  payload: DelayedSubmissionPayload
) =>
  Effect.gen(function* () {
    const executionId = yield* SubmitAfterDelay.executionId(payload)
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.interrupt(SubmitAfterDelay, executionId)
  })

export const DeliveryEventDeferred = DurableDeferred.make(
  "DeliveryEvent",
  { success: DeliveryEventType }
)

export const DeliveryEventWaitPayload = Schema.Struct({
  tenantId: TenantIdSchema,
  deliveryId: DeliveryIdSchema,
  types: Schema.optionalKey(Schema.Array(DeliveryEventType)),
  purpose: Schema.optionalKey(Schema.NonEmptyString),
  dispatchGeneration: Schema.optionalKey(Schema.Int)
})
export type DeliveryEventWaitPayload =
  typeof DeliveryEventWaitPayload.Type

export const WaitForDeliveryEvent = Workflow.make(
  "WaitForDeliveryEvent",
  {
    payload: DeliveryEventWaitPayload,
    success: DeliveryEventType,
    error: StoreUnavailable,
    idempotencyKey: (payload) =>
      workflowKey([
        payload.tenantId, payload.deliveryId,
        payload.types === undefined ? null : [...new Set(payload.types)].sort(),
        payload.purpose ?? null, payload.dispatchGeneration ?? null
      ])
  }
)

export const layerWaitForDeliveryEvent =
  WaitForDeliveryEvent.toLayer((payload) =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const instance = yield* WorkflowEngine.WorkflowInstance
      const matches = (type: typeof DeliveryEventType.Type) =>
        payload.types === undefined || payload.types.includes(type)
      const registered = yield* store.get(payload.deliveryId)
      if (Option.isSome(registered) && registered.value.tenantId !== undefined && registered.value.tenantId !== payload.tenantId) {
        return yield* StoreUnavailable.new({ message: "delivery event wait tenant does not own this delivery" })
      }
      yield* store.registerEventWait({
        executionId: instance.executionId, tenantId: payload.tenantId,
        deliveryId: payload.deliveryId, types: payload.types,
        dispatchGeneration: payload.dispatchGeneration ?? (Option.isSome(registered) ? registered.value.dispatchGeneration : undefined)
      })
      const existingWait = (yield* store.listEventWaits(payload.deliveryId)).find((wait) => wait.executionId === instance.executionId)
      const validEvents = Effect.gen(function* () {
        const intent = yield* store.get(payload.deliveryId)
        if (Option.isSome(intent) && (
          (intent.value.tenantId !== undefined && intent.value.tenantId !== payload.tenantId) ||
          (existingWait?.dispatchGeneration !== undefined && existingWait.dispatchGeneration !== intent.value.dispatchGeneration)
        )) {
          return yield* StoreUnavailable.new({ message: "delivery event wait was superseded or changed tenant" })
        }
        return (yield* store.listEvents(payload.deliveryId)).find((event) => matches(event.type) &&
          (Option.isNone(intent) || eventMatchesIntent(event, intent.value)))
      })
      while (true) {
        const existing = yield* validEvents
        if (existing !== undefined) {
          yield* store.removeEventWait(instance.executionId)
          return existing.type
        }
        const type = yield* DurableDeferred.await(DeliveryEventDeferred)
        const matching = yield* validEvents
        if (matching !== undefined) {
          yield* store.removeEventWait(instance.executionId)
          return matching.type
        }
        // A direct trusted completion can represent an event before admission.
        // Once an intent exists, its verified event history is authoritative.
        if (matches(type) && Option.isNone(yield* store.get(payload.deliveryId))) {
          yield* store.removeEventWait(instance.executionId)
          return type
        }
        yield* store.removeEventWait(instance.executionId)
        return yield* StoreUnavailable.new({
          message: `delivery event wait completed by non-matching event: ${type}`
        })
      }
    }).pipe(Effect.tapError(() => Effect.gen(function* () {
      const store = yield* DeliveryStore
      const instance = yield* WorkflowEngine.WorkflowInstance
      yield* store.removeEventWait(instance.executionId).pipe(Effect.ignore)
    })))
  )

export const interruptDeliveryEventWait = (
  tenantId: typeof TenantIdSchema.Type,
  deliveryId: typeof DeliveryIdSchema.Type,
  options: {
    readonly types?: ReadonlyArray<typeof DeliveryEventType.Type>
    readonly purpose?: string
    readonly dispatchGeneration?: number
  } = {}
) =>
  Effect.gen(function* () {
    const executionId = yield* WaitForDeliveryEvent.executionId({
      tenantId,
      deliveryId,
      ...(options.types === undefined ? {} : { types: options.types }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.dispatchGeneration === undefined ? {} : { dispatchGeneration: options.dispatchGeneration })
    })
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.interrupt(WaitForDeliveryEvent, executionId)
    const store = yield* Effect.serviceOption(DeliveryStore)
    if (Option.isSome(store)) yield* store.value.removeEventWait(executionId).pipe(Effect.ignore)
  })

export const completeDeliveryEvent = (
  tenantId: typeof TenantIdSchema.Type,
  deliveryId: typeof DeliveryIdSchema.Type,
  type: typeof DeliveryEventType.Type,
  options: {
    readonly types?: ReadonlyArray<typeof DeliveryEventType.Type>
    readonly purpose?: string
    readonly dispatchGeneration?: number
  } = {}
) =>
  Effect.gen(function* () {
    const executionId = yield* WaitForDeliveryEvent.executionId({
      tenantId,
      deliveryId,
      ...(options.types === undefined ? {} : { types: options.types }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.dispatchGeneration === undefined ? {} : { dispatchGeneration: options.dispatchGeneration })
    })
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.deferredDone(DeliveryEventDeferred, {
      workflowName: "WaitForDeliveryEvent",
      executionId,
      deferredName: DeliveryEventDeferred.name,
      exit: Exit.succeed(type)
    })
  })

export const notifyDeliveryEvent = (
  tenantId: typeof TenantIdSchema.Type,
  type: typeof DeliveryEventType.Type,
  waits: ReadonlyArray<DeliveryEventWait>,
  dispatchGeneration: number
) => Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine
  for (const wait of waits) {
    if (wait.tenantId !== tenantId || (wait.types !== undefined && !wait.types.includes(type)) ||
      (wait.dispatchGeneration !== undefined && wait.dispatchGeneration !== dispatchGeneration)) continue
    yield* engine.deferredDone(DeliveryEventDeferred, {
      workflowName: WaitForDeliveryEvent.name, executionId: wait.executionId,
      deferredName: DeliveryEventDeferred.name, exit: Exit.succeed(type)
    })
  }
})

export const layer = SubmitEmail.toLayer((payload) =>
  Effect.flatMap(SubmissionAdmission, (admission) =>
    admission.accept({
      tenantId: payload.tenantId,
      deliveryId: payload.deliveryId,
      message: payload.message,
      ...(payload.route === undefined
        ? {}
        : { route: payload.route }),
      ...(payload.providerIdempotencyKey === undefined
        ? {}
        : {
            providerIdempotencyKey:
              payload.providerIdempotencyKey
          })
    })
  )
)
