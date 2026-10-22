import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import { providerMessageId } from "../src/Ids"
import type { Transport } from "../src/EmailTransport"
import * as AhaSend from "../src/providers/AhaSend"

const respond = (status: number, body: unknown) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        })
      )
    )

const clientLayer = (
  handler: Parameters<typeof HttpClient.make>[0]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler))

const bodyOf = (request: HttpClientRequest.HttpClientRequest): any => {
  const body = request.body
  if (body._tag !== "Uint8Array") {
    return undefined
  }
  return JSON.parse(new TextDecoder().decode(body.body))
}

const headerValue = (
  headers: Headers.Headers,
  name: string
): string | undefined => {
  const value = Headers.get(headers, name)
  return value._tag === "Some" ? value.value : undefined
}

const emailLayerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

const options = {
  apiKey: Redacted.make("aha-sk-test"),
  accountId: "account-1"
} as const

describe("AhaSend", () => {
  it.effect("maps a single-recipient message onto the messages payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* AhaSend.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              idempotencyKey: headerValue(request.headers, "idempotency-key"),
              body: bodyOf(request)
            }
            return respond(200, {
              object: "list",
              data: [
                {
                  object: "message",
                  id: "<message-1@example.com>",
                  recipient: { email: "customer@example.com" },
                  status: "queued"
                }
              ]
            })(request)
          })
        )
      )

      const receipt = yield* Email.send(
        {
          to: "customer@example.com",
          subject: "Your receipt",
          text: "Receipt body",
          html: "<p>Receipt body</p>",
          replyTo: "support@example.com",
          headers: [["X-Campaign", "welcome"]],
          tags: ["receipt"]
        },
        { providerIdempotencyKey: "idem-1" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(
        captured.url.endsWith("/v2/accounts/account-1/messages")
      )
      assert.strictEqual(captured.authorization, "Bearer aha-sk-test")
      assert.strictEqual(captured.idempotencyKey, "idem-1")
      assert.deepStrictEqual(captured.body, {
        from: { email: "billing@example.com" },
        subject: "Your receipt",
        recipients: [{ email: "customer@example.com" }],
        reply_to: { email: "support@example.com" },
        text_content: "Receipt body",
        html_content: "<p>Receipt body</p>",
        headers: { "x-campaign": "welcome" },
        tags: ["receipt"]
      })
      assert.strictEqual(receipt.provider, "ahasend")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("<message-1@example.com>")
      )
    }))

  it.effect("addresses several recipients through the conversation route", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* AhaSend.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = { url: request.url, body: bodyOf(request) }
            return respond(200, {
              data: [
                { id: "<one@example.com>", status: "queued" },
                { id: "<two@example.com>", status: "queued" }
              ]
            })(request)
          })
        )
      )

      yield* Email.send({
        to: ["one@example.com", "two@example.com"],
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        subject: "Team update",
        text: "Body"
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(
        captured.url.endsWith("/v2/accounts/account-1/messages/conversation")
      )
      assert.deepStrictEqual(captured.body.to, [
        { email: "one@example.com" },
        { email: "two@example.com" }
      ])
      assert.deepStrictEqual(captured.body.cc, [{ email: "cc@example.com" }])
      assert.deepStrictEqual(captured.body.bcc, [{ email: "bcc@example.com" }])
      assert.isUndefined(captured.body.recipients)
    }))

  it.effect("reports a reused idempotency key as a conflict", () =>
    Effect.gen(function* () {
      const transport = yield* AhaSend.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(422, {
              message: "idempotency key was already used with a different request"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send(
          {
            to: "customer@example.com",
            subject: "Hi",
            text: "Body"
          },
          { providerIdempotencyKey: "idem-1" }
        ).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "IdempotencyConflict"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "IdempotencyConflict" &&
          result.failure.idempotencyKey,
        "idem-1"
      )
    }))

  it.effect("marks a running idempotency lease as retryable", () =>
    Effect.gen(function* () {
      const transport = yield* AhaSend.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(409, {
              message: "a request with this key is still running"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "customer@example.com",
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "RateLimited"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "RateLimited" &&
          result.failure.retryable,
        true
      )
    }))
})
