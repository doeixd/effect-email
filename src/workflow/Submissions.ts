import { Duration, Effect, Exit, Schema } from "effect"
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
    `${payload.tenantId}:${payload.deliveryId}`
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
    `${payload.tenantId}:${payload.deliveryId}:${payload.delayMillis}`
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
  purpose: Schema.optionalKey(Schema.NonEmptyString)
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
      `${payload.tenantId}:${payload.deliveryId}:${payload.purpose ?? payload.types?.slice().sort().join(",") ?? "any"}`
  }
)

export const layerWaitForDeliveryEvent =
  WaitForDeliveryEvent.toLayer((payload) =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore
      const matches = (type: typeof DeliveryEventType.Type) =>
        payload.types === undefined || payload.types.includes(type)
      while (true) {
        const events = yield* store.listEvents(payload.deliveryId)
        const existing = events.find((event) => matches(event.type))
        if (existing !== undefined) {
          return existing.type
        }
        const type = yield* DurableDeferred.await(DeliveryEventDeferred)
        if (matches(type)) {
          return type
        }
        const current = yield* store.listEvents(payload.deliveryId)
        const matching = current.find((event) => matches(event.type))
        if (matching !== undefined) {
          return matching.type
        }
        return yield* StoreUnavailable.new({
          message: `delivery event wait completed by non-matching event: ${type}`
        })
      }
    })
  )

export const interruptDeliveryEventWait = (
  tenantId: typeof TenantIdSchema.Type,
  deliveryId: typeof DeliveryIdSchema.Type,
  options: {
    readonly types?: ReadonlyArray<typeof DeliveryEventType.Type>
    readonly purpose?: string
  } = {}
) =>
  Effect.gen(function* () {
    const executionId = yield* WaitForDeliveryEvent.executionId({
      tenantId,
      deliveryId,
      ...(options.types === undefined ? {} : { types: options.types }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose })
    })
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.interrupt(WaitForDeliveryEvent, executionId)
  })

export const completeDeliveryEvent = (
  tenantId: typeof TenantIdSchema.Type,
  deliveryId: typeof DeliveryIdSchema.Type,
  type: typeof DeliveryEventType.Type,
  options: {
    readonly types?: ReadonlyArray<typeof DeliveryEventType.Type>
    readonly purpose?: string
  } = {}
) =>
  Effect.gen(function* () {
    const executionId = yield* WaitForDeliveryEvent.executionId({
      tenantId,
      deliveryId,
      ...(options.types === undefined ? {} : { types: options.types }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose })
    })
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* engine.deferredDone(DeliveryEventDeferred, {
      workflowName: "WaitForDeliveryEvent",
      executionId,
      deferredName: DeliveryEventDeferred.name,
      exit: Exit.succeed(type)
    })
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
