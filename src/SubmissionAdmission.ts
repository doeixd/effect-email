import { Context, DateTime, Effect, Layer, Option } from "effect"
import { PersistedQueue } from "effect/persistence"
import type { DeliveryId, RouteName, TenantId } from "./Ids"
import { gatewaySubmissionId } from "./Ids"
import type { EmailError } from "./EmailError"
import { InvalidMessage, RecipientSuppressed, StoreUnavailable } from "./EmailError"
import type { DeliveryEvent, DeliveryIntent } from "./DeliveryStore"
import { DeliveryStore } from "./DeliveryStore"
import type { MailboxInput, MessageDraft, MessageInput } from "./Message"
import { parseMailbox } from "./Message"
import type { AdmissionReceipt } from "./Submission"
import * as Submissions from "./queue/Submissions"
import type { RendererShape } from "./render/Template"
import type { SmtpSubmission } from "./smtp/Protocol"
import { SuppressionStore } from "./Suppression"

export interface AdmissionRequest {
  readonly tenantId: TenantId
  readonly message: MessageInput | MessageDraft
  readonly deliveryId?: DeliveryId
  readonly dispatchGeneration?: number
  readonly route?: RouteName
  readonly providerIdempotencyKey?: string
  readonly rawEnvelope?: {
    readonly mailFrom: string | null
    readonly rcptTo: ReadonlyArray<string>
  }
}

export interface SubmissionAdmissionOptions {
  readonly defaultFrom: MailboxInput
  readonly queueName?: string
  readonly maxAttempts?: number
  readonly renderer?: RendererShape
  readonly authorize?: (
    request: AdmissionRequest
  ) => Effect.Effect<void, EmailError>
  readonly validateRoute?: (
    route: RouteName | undefined
  ) => Effect.Effect<void, EmailError>
}

export interface SubmissionAdmissionShape {
  readonly queue: PersistedQueue.PersistedQueue<Submissions.SubmissionJob>
  readonly accept: (
    request: AdmissionRequest
  ) => Effect.Effect<AdmissionReceipt, EmailError>
  readonly acceptRaw: (
    tenantId: TenantId,
    submission: SmtpSubmission,
    options?: {
      readonly route?: RouteName
      readonly providerIdempotencyKey?: string
    }
  ) => Effect.Effect<AdmissionReceipt, EmailError>
  readonly get: (
    deliveryId: DeliveryId
  ) => Effect.Effect<Option.Option<DeliveryIntent>, StoreUnavailable>
  readonly cancel: (
    deliveryId: DeliveryId
  ) => Effect.Effect<void, StoreUnavailable>
  readonly isCancellationRequested: (
    deliveryId: DeliveryId
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly redrive: (
    deliveryId: DeliveryId
  ) => Effect.Effect<AdmissionReceipt, EmailError>
  readonly listUncertain: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listFailed: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly listPending: Effect.Effect<
    ReadonlyArray<DeliveryIntent>,
    StoreUnavailable
  >
  readonly appendProviderEvent: (
    event: DeliveryEvent
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly listEvents: (
    deliveryId: DeliveryId
  ) => Effect.Effect<ReadonlyArray<DeliveryEvent>, StoreUnavailable>
}

export class SubmissionAdmission extends Context.Service<
  SubmissionAdmission,
  SubmissionAdmissionShape
>()("@effect-email/SubmissionAdmission") {}

const mailboxAddresses = (
  input: MailboxInput | ReadonlyArray<MailboxInput>
): ReadonlyArray<string> => {
  const list = Array.isArray(input) ? input : [input]
  return list.flatMap((item) => {
    const parsed = parseMailbox(item)
    return parsed._tag === "ok" ? [parsed.value.address] : []
  })
}

const requestAddresses = (request: AdmissionRequest): ReadonlyArray<string> => {
  const addresses: Array<string> = []
  if ("content" in request.message) {
    addresses.push(
      ...request.message.to.map((entry) => entry.address),
      ...request.message.cc.map((entry) => entry.address),
      ...request.message.bcc.map((entry) => entry.address)
    )
  } else {
    addresses.push(
      ...mailboxAddresses(request.message.to),
      ...(request.message.cc === undefined
        ? []
        : mailboxAddresses(request.message.cc)),
      ...(request.message.bcc === undefined
        ? []
        : mailboxAddresses(request.message.bcc))
    )
  }
  if (request.rawEnvelope !== undefined) {
    addresses.push(...request.rawEnvelope.rcptTo)
  }
  return [...new Set(addresses)]
}

const submissionError = <E extends { readonly _tag: string }>(
  cause: E
): EmailError => {
  if (cause._tag === "PersistedQueueError") {
    return new StoreUnavailable({
      message: "submission queue unavailable",
      cause
    })
  }
  if (cause._tag === "SchemaError") {
    return new InvalidMessage({
      message: "submission could not be encoded",
      issues:
        (cause as { readonly message?: string }).message ?? String(cause)
    })
  }
  return cause as unknown as EmailError
}

export const make = (
  options: SubmissionAdmissionOptions
): Effect.Effect<
  SubmissionAdmissionShape,
  never,
  DeliveryStore | PersistedQueue.PersistedQueueFactory
> =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore
    const suppressionStore = yield* Effect.serviceOption(
      SuppressionStore
    )
    const queue = yield* Submissions.make({
      ...(options.queueName === undefined
        ? {}
        : { name: options.queueName }),
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts })
    })

    const accept = Effect.fn("SubmissionAdmission.accept")(function* (
      request: AdmissionRequest
    ) {
      yield* options.validateRoute?.(request.route) ?? Effect.void
      yield* options.authorize?.(request) ?? Effect.void
      if (Option.isSome(suppressionStore)) {
        const blocked = yield* suppressionStore.value.suppressed(
          request.tenantId,
          requestAddresses(request)
        )
        if (blocked.length > 0) {
          return yield* new RecipientSuppressed({
            message: `recipient is suppressed: ${blocked.join(", ")}`,
            recipients: blocked
          })
        }
      }
      const submitted = yield* Submissions.submit(
        queue,
        request.tenantId,
        {
          ...(request.deliveryId === undefined
            ? {}
            : { deliveryId: request.deliveryId }),
          ...(request.dispatchGeneration === undefined
            ? {}
            : { dispatchGeneration: request.dispatchGeneration }),
          message: request.message,
          defaultFrom: options.defaultFrom,
          ...(request.route === undefined ? {} : { route: request.route }),
          ...(request.providerIdempotencyKey === undefined
            ? {}
            : {
                providerIdempotencyKey:
                  request.providerIdempotencyKey
              }),
          ...(request.rawEnvelope === undefined
            ? {}
            : { rawEnvelope: request.rawEnvelope })
        },
        options.renderer === undefined
          ? {}
          : { renderer: options.renderer }
      ).pipe(
        Effect.provideService(DeliveryStore, store),
        Effect.mapError(submissionError)
      )
      const acceptedAt = yield* DateTime.now
      return {
        gatewaySubmissionId: gatewaySubmissionId(
          `sub_${submitted.deliveryId}`
        ),
        deliveryId: submitted.deliveryId,
        acceptedAt,
        ...(request.route === undefined
          ? {}
          : { route: request.route })
      }
    })

    const redrive = Effect.fn("SubmissionAdmission.redrive")(
      function* (deliveryId: DeliveryId) {
        const stored = yield* store.get(deliveryId)
        if (Option.isNone(stored)) {
          return yield* new StoreUnavailable({
            message: `delivery intent not found: ${deliveryId}`
          })
        }
        const intent = stored.value
        if (intent.tenantId === undefined) {
          return yield* new StoreUnavailable({
            message: `delivery intent has no tenant: ${deliveryId}`
          })
        }
        yield* Submissions.redrive(queue, {
          version: 1,
          tenantId: intent.tenantId,
          deliveryId,
          dispatchGeneration: intent.dispatchGeneration
        }).pipe(
          Effect.provideService(DeliveryStore, store),
          Effect.mapError(submissionError)
        )
        const acceptedAt = yield* DateTime.now
        return {
          gatewaySubmissionId: gatewaySubmissionId(
            `sub_${deliveryId}`
          ),
          deliveryId,
          acceptedAt,
          ...(intent.route === undefined
            ? {}
            : { route: intent.route })
        }
      }
    )

    const acceptRaw: SubmissionAdmissionShape["acceptRaw"] =
      Effect.fn("SubmissionAdmission.acceptRaw")(
        function* (
          tenantId: TenantId,
          submission: SmtpSubmission,
          rawOptions: {
            readonly route?: RouteName
            readonly providerIdempotencyKey?: string
          } = {}
        ) {
          return yield* accept({
            tenantId,
            message: {
              to: submission.rcptTo,
              ...(submission.mailFrom === null
                ? {}
                : { from: submission.mailFrom }),
              subject: "",
              rawMime: submission.content
            },
            ...(rawOptions.route === undefined
              ? {}
              : { route: rawOptions.route }),
            ...(rawOptions.providerIdempotencyKey === undefined
              ? {}
              : {
                  providerIdempotencyKey:
                    rawOptions.providerIdempotencyKey
                }),
            rawEnvelope: {
              mailFrom: submission.mailFrom,
              rcptTo: submission.rcptTo
            }
          })
        }
      )

    const get: SubmissionAdmissionShape["get"] = store.get
    const cancel: SubmissionAdmissionShape["cancel"] =
      store.requestCancellation

    return {
      queue,
      accept,
      acceptRaw,
      get,
      cancel,
      isCancellationRequested: store.isCancellationRequested,
      redrive,
      listUncertain: store.listUncertain,
      listFailed: store.listFailed,
      listPending: store.listPending,
      appendProviderEvent: store.appendProviderEvent,
      listEvents: store.listEvents
    }
  })

export const layer = (
  options: SubmissionAdmissionOptions
): Layer.Layer<
  SubmissionAdmission,
  never,
  DeliveryStore | PersistedQueue.PersistedQueueFactory
> => Layer.effect(SubmissionAdmission, make(options))

export const accept = (
  request: AdmissionRequest
): Effect.Effect<AdmissionReceipt, EmailError, SubmissionAdmission> =>
  Effect.flatMap(SubmissionAdmission, (admission) =>
    admission.accept(request)
  )

export const get = (
  deliveryId: DeliveryId
): Effect.Effect<
  Option.Option<DeliveryIntent>,
  StoreUnavailable,
  SubmissionAdmission
> =>
  Effect.flatMap(SubmissionAdmission, (admission) =>
    admission.get(deliveryId)
  )

export const cancel = (
  deliveryId: DeliveryId
): Effect.Effect<void, StoreUnavailable, SubmissionAdmission> =>
  Effect.flatMap(SubmissionAdmission, (admission) =>
    admission.cancel(deliveryId)
  )
