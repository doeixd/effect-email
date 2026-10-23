import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import { certaintyOf, isRetryable } from "../src/EmailError"
import * as Resend from "../src/providers/Resend"

interface RecordedRequest {
  readonly url: string
  readonly headers: Headers.Headers
  readonly body: unknown
}

const headerValue = (
  headers: Headers.Headers,
  name: string
): string | undefined => {
  const value = Headers.get(headers, name)
  return value._tag === "Some" ? value.value : undefined
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body
  if (body._tag !== "Uint8Array") {
    return undefined
  }
  return JSON.parse(new TextDecoder().decode(body.body))
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers }
        })
      )
    )

const clientLayer = (
  handler: Parameters<typeof HttpClient.make>[0]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler))

const sendProgram = (recorder?: Array<RecordedRequest>) =>
  Effect.gen(function* () {
    const transport = yield* Resend.make({
      apiKey: Redacted.make("re_test_key"),
      account: "billing"
    })
    const emailLayer = Email.layer({
      defaultFrom: "billing@example.com",
      routes: { default: transport }
    })
    return yield* Email.send({
      to: "customer@example.com",
      subject: "Your receipt",
      text: "Receipt body"
    }).pipe(Effect.provide(emailLayer))
  }).pipe(
    Effect.provide(
      clientLayer((request) => {
        if (recorder !== undefined) {
          recorder.push({
            url: request.url,
            headers: request.headers,
            body: bodyOf(request)
          })
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ id: "re_message_1" }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-request-id": "req_123"
              }
            })
          )
        )
      })
    )
  )

const sendError = (handler: Parameters<typeof HttpClient.make>[0]) =>
  Effect.gen(function* () {
    const transport = yield* Resend.make({
      apiKey: Redacted.make("re_test_key")
    })
    const emailLayer = Email.layer({
      defaultFrom: "billing@example.com",
      routes: { default: transport }
    })
    return yield* Email.send({
      to: "customer@example.com",
      subject: "Hi",
      text: "Body"
    }).pipe(Effect.provide(emailLayer), Effect.flip)
  }).pipe(Effect.provide(clientLayer(handler)))

describe("Resend", () => {
  it.effect("maps a prepared message onto the Resend payload", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = []
      const receipt = yield* sendProgram(requests)

      assert.strictEqual(requests.length, 1)
      const request = requests[0]!
      assert.isTrue(request.url.endsWith("/emails"))
      assert.strictEqual(
        headerValue(request.headers, "authorization"),
        "Bearer re_test_key"
      )
      assert.deepStrictEqual(request.body, {
        from: "billing@example.com",
        to: ["customer@example.com"],
        subject: "Your receipt",
        text: "Receipt body"
      })

      assert.strictEqual(receipt.provider, "resend")
      assert.strictEqual(receipt.destinationId, "resend:billing")
      assert.strictEqual(receipt.providerMessageId, "re_message_1")
      assert.strictEqual(receipt.requestId, "req_123")
    }))

  it.effect("rejects attachments that reference local paths", () =>
    Effect.gen(function* () {
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("HTTP must not be called"))
      )
      const transport = yield* Resend.make({
        apiKey: Redacted.make("re_test_key")
      }).pipe(Effect.provide(httpLayer))
      const emailLayer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })
      const error = yield* Email.send({
        to: "customer@example.com",
        subject: "Hi",
        text: "Body",
        attachments: [
          {
            filename: "receipt.pdf",
            source: { _tag: "path", path: "C:/receipts/1.pdf" }
          }
        ]
      }).pipe(
        Effect.provide(emailLayer),
        Effect.provide(httpLayer),
        Effect.flip
      )

      assert.strictEqual(error._tag, "UnsupportedCapability")
      assert.strictEqual(certaintyOf(error), "not-submitted")
    }))

  it.effect("maps 422 responses to a definite rejection", () =>
    Effect.gen(function* () {
      const error = yield* sendError(
        respond(422, {
          statusCode: 422,
          name: "validation_error",
          message: "invalid to field"
        })
      )

      assert.strictEqual(error._tag, "ProviderRejected")
      assert.strictEqual(certaintyOf(error), "rejected")
      assert.isFalse(isRetryable(error))
      if (error._tag === "ProviderRejected") {
        assert.strictEqual(error.status, 422)
        assert.strictEqual(error.message, "invalid to field")
      }
    }))

  it.effect("maps 429 responses to RateLimited with Retry-After", () =>
    Effect.gen(function* () {
      const error = yield* sendError(
        respond(429, { message: "too many requests" }, { "retry-after": "2" })
      )

      assert.strictEqual(error._tag, "RateLimited")
      assert.isTrue(isRetryable(error))
      if (error._tag === "RateLimited") {
        assert.strictEqual(error.retryAfterMillis, 2000)
      }
    }))

  it.effect("treats concurrent idempotency requests as retryable", () =>
    Effect.gen(function* () {
      const error = yield* sendError(
        respond(409, {
          name: "concurrent_idempotent_requests",
          message: "request already in progress"
        })
      )

      assert.strictEqual(error._tag, "RateLimited")
      assert.isTrue(isRetryable(error))
    }))

  it.effect("maps idempotency key conflicts distinctly", () =>
    Effect.gen(function* () {
      const error = yield* sendError(
        respond(409, {
          name: "invalid_idempotent_request",
          message: "key was used with different payload"
        })
      )

      assert.strictEqual(error._tag, "IdempotencyConflict")
      assert.strictEqual(certaintyOf(error), "rejected")
    }))

  it.effect("maps 5xx responses to TransportUnavailable", () =>
    Effect.gen(function* () {
      const error = yield* sendError(
        respond(503, { message: "unavailable" })
      )

      assert.strictEqual(error._tag, "TransportUnavailable")
      assert.isTrue(isRetryable(error))
      assert.strictEqual(certaintyOf(error), "not-submitted")
    }))

  it.effect("maps 401 responses to AuthenticationFailed", () =>
    Effect.gen(function* () {
      const error = yield* sendError(respond(401, { message: "invalid key" }))

      assert.strictEqual(error._tag, "AuthenticationFailed")
      assert.strictEqual(certaintyOf(error), "rejected")
    }))

  it.effect("marks malformed success responses as uncertain", () =>
    Effect.gen(function* () {
      const error = yield* sendError(respond(200, { unexpected: true }))

      assert.strictEqual(error._tag, "MalformedProviderResponse")
      assert.strictEqual(certaintyOf(error), "unknown")
    }))

  it.effect("marks pre-response HTTP failures as uncertain", () =>
    Effect.gen(function* () {
      const error = yield* sendError((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("socket closed")
            })
          })
        )
      )

      assert.strictEqual(error._tag, "DeliveryUncertain")
      assert.strictEqual(certaintyOf(error), "unknown")
      assert.isFalse(isRetryable(error))
    }))

  it.effect("forwards an idempotency key", () =>
    Effect.gen(function* () {
      let authorization: string | undefined
      let idempotencyKey: string | undefined
      const httpLayer = clientLayer((request) => {
        authorization = headerValue(request.headers, "authorization")
        idempotencyKey = headerValue(request.headers, "idempotency-key")
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ id: "re_1" }), { status: 200 })
          )
        )
      })
      const transport = yield* Resend.make({
        apiKey: Redacted.make("re_test_key")
      }).pipe(Effect.provide(httpLayer))
      const emailLayer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      yield* Email.send(
        {
          to: "customer@example.com",
          subject: "Hi",
          text: "Body"
        },
        { providerIdempotencyKey: "idem_123" }
      ).pipe(Effect.provide(emailLayer), Effect.provide(httpLayer))

      assert.strictEqual(authorization, "Bearer re_test_key")
      assert.strictEqual(idempotencyKey, "idem_123")
    }))
})

