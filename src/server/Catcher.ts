import { DateTime, Effect, Option } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { DeliveryIntent } from "../DeliveryStore"
import { DeliveryStore } from "../DeliveryStore"
import { AuthenticationFailed } from "../EmailError"
import type { EmailError } from "../EmailError"
import { deliveryId as makeDeliveryId } from "../Ids"

const parseSegments = (url: string): ReadonlyArray<string> =>
  new URL(url, "http://localhost")
    .pathname.split("/")
    .filter((segment) => segment.length > 0)

const isCollection = (segments: ReadonlyArray<string>): boolean =>
  (segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "catcher") ||
  (segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "catcher" &&
    segments[2] === "emails")

const messageId = (
  segments: ReadonlyArray<string>
): string | undefined =>
  segments.length === 4 &&
  segments[0] === "v1" &&
  segments[1] === "catcher" &&
  segments[2] === "emails"
    ? segments[3]
    : undefined

const subjectOf = (intent: DeliveryIntent): string | undefined =>
  "subject" in intent.message ? intent.message.subject : undefined

const recipientsOf = (intent: DeliveryIntent): unknown =>
  "to" in intent.message ? intent.message.to : undefined

const summary = (intent: DeliveryIntent) => ({
  deliveryId: intent.deliveryId,
  ...(intent.tenantId === undefined ? {} : { tenantId: intent.tenantId }),
  status: intent.status,
  attempts: intent.attempts,
  cancellationRequested: intent.cancellationRequested,
  updatedAt: DateTime.formatIso(intent.updatedAt),
  ...(subjectOf(intent) === undefined
    ? {}
    : { subject: subjectOf(intent) }),
  ...(recipientsOf(intent) === undefined
    ? {}
    : { to: recipientsOf(intent) }),
  ...(intent.receipt === undefined
    ? {}
    : {
        provider: intent.receipt.provider,
        providerMessageId: intent.receipt.providerMessageId
      })
})

const unavailable = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        tag: "StoreUnavailable",
        message: "catcher storage unavailable"
      }
    },
    { status: 503 }
  )

export interface CatcherOptions {
  readonly authorize?: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<void, EmailError>
}

const denyUnauthorized = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<void, EmailError> =>
  Effect.fail(
    AuthenticationFailed.new({
      message: `catcher authorization required for ${request.method} ${request.url}`,
      provider: "catcher"
    })
  )

const makeHandler = (options: CatcherOptions): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  DeliveryStore | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const authorized = yield* Effect.result(
    (options.authorize ?? denyUnauthorized)(request)
  )
  if (authorized._tag === "Failure") {
    return HttpServerResponse.jsonUnsafe(
      {
        error: {
          tag: "AuthenticationFailed",
          message: "catcher authorization required"
        }
      },
      { status: 401 }
    )
  }
  const store = yield* DeliveryStore
  const segments = parseSegments(request.url)
  const id = messageId(segments)

  if (request.method === "GET" && isCollection(segments)) {
    const listed = yield* Effect.result(store.listAll)
    if (listed._tag === "Failure") {
      return unavailable()
    }
    return HttpServerResponse.jsonUnsafe({
      emails: listed.success.map(summary)
    })
  }

  if (request.method === "GET" && id !== undefined) {
    const stored = yield* Effect.result(
      store.get(makeDeliveryId(id))
    )
    if (stored._tag === "Failure") {
      return unavailable()
    }
    if (Option.isNone(stored.success)) {
      return HttpServerResponse.jsonUnsafe(
        { error: { tag: "NotFound", message: "email not found" } },
        { status: 404 }
      )
    }
    const intent = stored.success.value
    return HttpServerResponse.jsonUnsafe({
      ...summary(intent),
      message: intent.message,
      ...(intent.error === undefined
        ? {}
        : { error: intent.error as EmailError })
    })
  }

  return HttpServerResponse.jsonUnsafe(
    { error: { tag: "NotFound", message: "route not found" } },
    { status: 404 }
  )
})

export const make = (
  options: CatcherOptions = {}
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  DeliveryStore | HttpServerRequest.HttpServerRequest
> => makeHandler(options)

export const handler = make()
