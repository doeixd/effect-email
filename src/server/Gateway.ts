import { ByteSize, DateTime, Effect, Option, Schema } from "effect"
import { WorkflowEngine } from "effect/workflow"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { EmailError } from "../EmailError"
import type { DeliveryIntent } from "../DeliveryStore"
import { DeliveryEventType } from "../DeliveryStore"
import {
  AuthenticationFailed,
  IdempotencyConflict,
  InvalidMessage,
  RateLimited,
  StoreUnavailable,
  TemplateError,
  UnsupportedCapability
} from "../EmailError"
import {
  deliveryId as makeDeliveryId,
  tenantId as makeTenantId
} from "../Ids"
import {
  DeliveryId as DeliveryIdSchema,
  RouteName as RouteNameSchema,
  TenantId as TenantIdSchema
} from "../Ids"
import { MessageInputSchema } from "../Message"
import { SubmissionAdmission } from "../SubmissionAdmission"
import { completeDeliveryEvent } from "../workflow/Submissions"

export const SubmissionRequest = Schema.Struct({
  tenantId: TenantIdSchema,
  message: MessageInputSchema,
  deliveryId: Schema.optionalKey(DeliveryIdSchema),
  dispatchGeneration: Schema.optionalKey(Schema.Int),
  route: Schema.optionalKey(RouteNameSchema),
  providerIdempotencyKey: Schema.optionalKey(Schema.String)
})
export type SubmissionRequest = typeof SubmissionRequest.Type

const EventRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  type: DeliveryEventType,
  occurredAt: Schema.optionalKey(Schema.DateTimeUtc),
  payload: Schema.optionalKey(Schema.Json)
})
type EventRequest = typeof EventRequest.Type

const errorStatus = (error: EmailError): number => {
  switch (error._tag) {
    case "AuthenticationFailed":
      return 401
    case "RateLimited":
      return 429
    case "IdempotencyConflict":
      return 409
    case "InvalidMessage":
    case "TemplateError":
    case "RecipientSuppressed":
      return 422
    case "UnsupportedCapability":
      return error.capability === "authorization" ? 403 : 422
    case "StoreUnavailable":
      return 503
    default:
      return 500
  }
}

const errorResponse = (error: EmailError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        tag: error._tag,
        message: error.message
      }
    },
    { status: errorStatus(error) }
  )

const parsePath = (url: string): ReadonlyArray<string> => {
  const parsed = new URL(url, "http://localhost")
  return parsed.pathname.split("/").filter((segment) => segment.length > 0)
}

const isEmailCollection = (segments: ReadonlyArray<string>): boolean =>
  (segments.length === 1 && segments[0] === "emails") ||
  (segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "emails")

const emailId = (
  segments: ReadonlyArray<string>
): string | undefined => {
  if (segments.length === 2 && segments[0] === "emails") {
    return segments[1]
  }
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "emails"
  ) {
    return segments[2]
  }
  return undefined
}

const intentSummary = (intent: DeliveryIntent) => ({
  deliveryId: intent.deliveryId,
  status: intent.status,
  attempts: intent.attempts,
  cancellationRequested: intent.cancellationRequested,
  updatedAt: DateTime.formatIso(intent.updatedAt),
  ...(intent.receipt === undefined
    ? {}
    : {
        provider: intent.receipt.provider,
        providerMessageId: intent.receipt.providerMessageId
      })
})

const redriveId = (
  segments: ReadonlyArray<string>
): string | undefined => {
  if (
    segments.length === 3 &&
    segments[0] === "emails" &&
    segments[2] === "redrive"
  ) {
    return segments[1]
  }
  if (
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "emails" &&
    segments[3] === "redrive"
  ) {
    return segments[2]
  }
  return undefined
}

const isDeliveryCollection = (
  segments: ReadonlyArray<string>
): boolean =>
  (segments.length === 1 && segments[0] === "deliveries") ||
  (segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "deliveries")

const eventDeliveryId = (
  segments: ReadonlyArray<string>
): string | undefined => {
  if (
    segments.length === 3 &&
    segments[0] === "emails" &&
    segments[2] === "events"
  ) {
    return segments[1]
  }
  if (
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "emails" &&
    segments[3] === "events"
  ) {
    return segments[2]
  }
  return undefined
}

const eventJson = (event: import("../DeliveryStore").DeliveryEvent) => ({
  id: event.id,
  ...(event.deliveryId === undefined
    ? {}
    : { deliveryId: event.deliveryId }),
  type: event.type,
  occurredAt: DateTime.formatIso(event.occurredAt),
  ...(event.payload === undefined ? {} : { payload: event.payload })
})

const isHealth = (segments: ReadonlyArray<string>): boolean =>
  (segments.length === 1 && segments[0] === "healthz") ||
  (segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "healthz")

const isDiagnostics = (segments: ReadonlyArray<string>): boolean =>
  (segments.length === 1 && segments[0] === "diagnostics") ||
  (segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "diagnostics")

export interface GatewayOptions {
  readonly maxBodySize?: ByteSize.ByteSize
  readonly authorize?: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<void, EmailError>
  readonly verifyEvent?: (
    request: HttpServerRequest.HttpServerRequest,
    event: EventRequest,
    rawBody: string
  ) => Effect.Effect<void, EmailError>
}

const denyEventVerification = (): Effect.Effect<void, EmailError> =>
  Effect.fail(
    new AuthenticationFailed({
      message: "provider event verification is required",
      provider: "gateway"
    })
  )

const denyUnauthorized = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<void, EmailError> =>
  Effect.fail(
    new AuthenticationFailed({
      message: `authorization required for ${request.method} ${request.url}`,
      provider: "gateway"
    })
  )

const makeHandle = (options: GatewayOptions) =>
  Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const admission = yield* SubmissionAdmission
  const segments = parsePath(request.url)
  const id = emailId(segments)
  const targetRedrive = redriveId(segments)
  const eventTarget = eventDeliveryId(segments)
  const parsedUrl = new URL(request.url, "http://localhost")

  if (!isHealth(segments)) {
    yield* options.authorize?.(request) ?? Effect.void
  }

  if (request.method === "POST") {
    const declared = Number(request.headers["content-length"])
    if (
      Number.isFinite(declared) &&
      BigInt(Math.trunc(declared)) >
        (options.maxBodySize ?? ByteSize.mebibytes(10))
    ) {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "request body is too large"
          }
        },
        { status: 413 }
      )
    }
  }

  if (request.method === "GET" && isDiagnostics(segments)) {
    const summary = yield* admission.statusSummary
    const entry = (status: string) =>
      summary.find((item) => item.status === status)
    const pending = entry("pending")
    const failed = entry("failed")
    const uncertain = entry("uncertain")
    return HttpServerResponse.jsonUnsafe({
      queue: {
        pending: pending?.count ?? 0,
        ...(pending?.oldestUpdatedAt === undefined
          ? {}
          : { oldestPendingAt: DateTime.formatIso(pending.oldestUpdatedAt) })
      },
      deadLetter: {
        failed: failed?.count ?? 0,
        ...(failed?.oldestUpdatedAt === undefined
          ? {}
          : { oldestFailedAt: DateTime.formatIso(failed.oldestUpdatedAt) })
      },
      parked: {
        uncertain: uncertain?.count ?? 0,
        ...(uncertain?.oldestUpdatedAt === undefined
          ? {}
          : {
              oldestUncertainAt: DateTime.formatIso(
                uncertain.oldestUpdatedAt
              )
            })
      }
    })
  }
  if (request.method === "GET" && isHealth(segments)) {
    const checked = yield* Effect.result(admission.statusSummary)
    if (checked._tag === "Failure") {
      return errorResponse(checked.failure)
    }
    return HttpServerResponse.jsonUnsafe({ status: "ok" })
  }

  if (request.method === "POST" && isEmailCollection(segments)) {
    const decoded = yield* Effect.result(
      HttpServerRequest.schemaBodyJson(SubmissionRequest)
    )
    if (decoded._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "request body did not match the submission schema"
          }
        },
        { status: 400 }
      )
    }
    const body = decoded.success
    const accepted = yield* Effect.result(
      admission.accept({
        tenantId: body.tenantId,
        message: body.message,
        ...(body.deliveryId === undefined
          ? {}
          : { deliveryId: body.deliveryId }),
        ...(body.dispatchGeneration === undefined
          ? {}
          : { dispatchGeneration: body.dispatchGeneration }),
        ...(body.route === undefined ? {} : { route: body.route }),
        ...(body.providerIdempotencyKey === undefined
          ? {}
          : {
              providerIdempotencyKey: body.providerIdempotencyKey
            })
      })
    )
    if (accepted._tag === "Failure") {
      return errorResponse(accepted.failure)
    }
    return HttpServerResponse.jsonUnsafe(
      {
        gatewaySubmissionId: accepted.success.gatewaySubmissionId,
        deliveryId: accepted.success.deliveryId,
        acceptedAt: DateTime.formatIso(accepted.success.acceptedAt),
        ...(accepted.success.route === undefined
          ? {}
          : { route: accepted.success.route })
      },
      { status: 202 }
    )
  }

  if (eventTarget !== undefined && request.method === "POST") {
    const raw = yield* Effect.result(request.text)
    if (raw._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "invalid provider event body"
          }
        },
        { status: 400 }
      )
    }
    const parsed = yield* Effect.result(
      Effect.try({
        try: () => JSON.parse(raw.success) as unknown,
        catch: () => undefined
      })
    )
    if (parsed._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "invalid provider event body"
          }
        },
        { status: 400 }
      )
    }
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(EventRequest)(parsed.success)
    )
    if (decoded._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "invalid provider event body"
          }
        },
        { status: 400 }
      )
    }
    const verified = yield* Effect.result(
      (options.verifyEvent ?? denyEventVerification)(
        request,
        decoded.success,
        raw.success
      )
    )
    if (verified._tag === "Failure") {
      return errorResponse(verified.failure)
    }
    const occurredAt = decoded.success.occurredAt ?? (yield* DateTime.now)
    const inserted = yield* admission.appendProviderEvent({
      id: decoded.success.id,
      deliveryId: makeDeliveryId(eventTarget),
      type: decoded.success.type,
      occurredAt,
      ...(decoded.success.payload === undefined
        ? {}
        : { payload: decoded.success.payload })
    })
    if (inserted) {
      const engine = yield* Effect.serviceOption(
        WorkflowEngine.WorkflowEngine
      )
      if (Option.isSome(engine)) {
        const stored = yield* admission.get(
          makeDeliveryId(eventTarget)
        )
        if (
          Option.isSome(stored) &&
          stored.value.tenantId !== undefined
        ) {
          yield* completeDeliveryEvent(
            stored.value.tenantId,
            makeDeliveryId(eventTarget),
            decoded.success.type
          ).pipe(
            Effect.provideService(
              WorkflowEngine.WorkflowEngine,
              engine.value
            ),
            Effect.ignore
          )
        }
      }
    }
    return HttpServerResponse.jsonUnsafe(
      { inserted },
      { status: 202 }
    )
  }

  if (eventTarget !== undefined && request.method === "GET") {
    const events = yield* admission.listEvents(
      makeDeliveryId(eventTarget)
    )
    return HttpServerResponse.jsonUnsafe({
      events: events.map(eventJson)
    })
  }

  if (request.method === "POST" && targetRedrive !== undefined) {
    const redriven = yield* Effect.result(
      admission.redrive(makeDeliveryId(targetRedrive), {
        acknowledgeDuplicateRisk:
          request.headers[
            "x-effect-email-acknowledge-duplicate-risk"
          ] === "true",
        ...(request.headers["x-effect-email-redrive-actor"] === undefined
          ? {}
          : {
              actor: request.headers["x-effect-email-redrive-actor"]
            }),
        ...(request.headers["x-effect-email-redrive-reason"] === undefined
          ? {}
          : {
              reason: request.headers["x-effect-email-redrive-reason"]
            })
      })
    )
    if (redriven._tag === "Failure") {
      return errorResponse(redriven.failure)
    }
    return HttpServerResponse.jsonUnsafe(
      {
        gatewaySubmissionId: redriven.success.gatewaySubmissionId,
        deliveryId: redriven.success.deliveryId,
        acceptedAt: DateTime.formatIso(redriven.success.acceptedAt),
        ...(redriven.success.route === undefined
          ? {}
          : { route: redriven.success.route })
      },
      { status: 202 }
    )
  }

  if (request.method === "GET" && isDeliveryCollection(segments)) {
    const status = parsedUrl.searchParams.get("status")
    if (status !== "uncertain" && status !== "failed") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "status must be uncertain or failed"
          }
        },
        { status: 400 }
      )
    }
    const tenantParam = parsedUrl.searchParams.get("tenantId")
    if (tenantParam !== null && tenantParam.length === 0) {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "tenantId must not be empty"
          }
        },
        { status: 400 }
      )
    }
    const limitParam = Number(
      parsedUrl.searchParams.get("limit") ?? "100"
    )
    if (!Number.isInteger(limitParam) || limitParam < 1) {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "limit must be a positive integer"
          }
        },
        { status: 400 }
      )
    }
    const afterParam = parsedUrl.searchParams.get("after")
    if (afterParam !== null && afterParam.length === 0) {
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            tag: "InvalidMessage",
            message: "after must not be empty"
          }
        },
        { status: 400 }
      )
    }
    const listed =
      tenantParam === null
        ? status === "uncertain"
          ? yield* admission.listUncertain
          : yield* admission.listFailed
        : yield* admission.listForTenant({
            tenantId: makeTenantId(tenantParam),
            status,
            limit: limitParam,
            ...(afterParam === null
              ? {}
              : { after: makeDeliveryId(afterParam) })
          })
    return HttpServerResponse.jsonUnsafe({
      deliveries: listed.map(intentSummary)
    })
  }

  if (id !== undefined && request.method === "GET") {
    const delivery = yield* admission.get(makeDeliveryId(id))
    if (Option.isNone(delivery)) {
      return HttpServerResponse.jsonUnsafe(
        { error: { tag: "NotFound", message: "delivery not found" } },
        { status: 404 }
      )
    }
    return HttpServerResponse.jsonUnsafe(intentSummary(delivery.value))
  }

  if (id !== undefined && request.method === "DELETE") {
    const canceled = yield* Effect.result(
      admission.cancel(makeDeliveryId(id))
    )
    if (canceled._tag === "Failure") {
      return errorResponse(canceled.failure)
    }
    return HttpServerResponse.jsonUnsafe(
      {
        deliveryId: id,
        cancellationRequested: true,
        outcome: canceled.success
      },
      { status: 202 }
    )
  }

  return HttpServerResponse.jsonUnsafe(
    { error: { tag: "NotFound", message: "route not found" } },
    { status: 404 }
  )
})

export const make = (
  options: GatewayOptions = {}
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | SubmissionAdmission
> =>
  makeHandle({
    authorize: options.authorize ?? denyUnauthorized,
    verifyEvent: options.verifyEvent ?? denyEventVerification,
    ...(options.maxBodySize === undefined
      ? {}
      : { maxBodySize: options.maxBodySize })
  }).pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      options.maxBodySize ?? ByteSize.mebibytes(10)
    ),
    Effect.catch((error: EmailError | InvalidMessage) =>
      Effect.succeed(errorResponse(error as EmailError))
    )
  )

export const handler = make()
