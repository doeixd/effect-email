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
import * as Loops from "../src/providers/Loops"

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

const options = { apiKey: Redacted.make("loops-test") } as const

describe("Loops", () => {
  it.effect("maps a provider template onto the transactional payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Loops.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              idempotencyKey: headerValue(request.headers, "idempotency-key"),
              body: bodyOf(request)
            }
            return respond(200, { success: true })(request)
          })
        )
      )

      const receipt = yield* Email.send(
        {
          to: "ada@example.com",
          subject: "ignored by Loops",
          providerTemplate: {
            id: "clfq6dinn000yl70fgwwyp82l",
            variables: { name: "Ada", plan: "pro" }
          },
          tags: ["welcome"],
          attachments: [
            {
              filename: "notes.txt",
              contentType: "text/plain",
              source: {
                _tag: "content",
                content: new TextEncoder().encode("hello"),
                encoding: "utf8"
              }
            }
          ]
        },
        { providerIdempotencyKey: "idem-1" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/api/v1/transactional"))
      assert.strictEqual(captured.authorization, "Bearer loops-test")
      assert.strictEqual(captured.idempotencyKey, "idem-1")
      assert.deepStrictEqual(captured.body, {
        transactionalId: "clfq6dinn000yl70fgwwyp82l",
        email: "ada@example.com",
        dataVariables: {
          name: "Ada",
          plan: "pro",
          welcome: true
        },
        attachments: [
          {
            filename: "notes.txt",
            contentType: "text/plain",
            data: "aGVsbG8="
          }
        ]
      })
      assert.strictEqual(receipt.provider, "loops")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("idem-1")
      )
    }))

  it.effect("refuses a message that does not name a provider template", () =>
    Effect.gen(function* () {
      const transport = yield* Loops.make(options).pipe(
        Effect.provide(clientLayer(respond(200, { success: true })))
      )

      const result = yield* Effect.result(
        Email.send({
          to: "ada@example.com",
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "UnsupportedCapability"
      )
    }))

  it.effect("surfaces a nested provider failure message", () =>
    Effect.gen(function* () {
      const transport = yield* Loops.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              message: "Bad Request",
              error: {
                message: "transactionalId is invalid",
                reason: "not_found"
              }
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "ada@example.com",
          subject: "Hi",
          providerTemplate: { id: "missing" }
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "ProviderRejected"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "ProviderRejected" &&
          result.failure.message,
        "Bad Request: transactionalId is invalid (not_found)"
      )
    }))

  it.effect("treats a success false body as a rejection", () =>
    Effect.gen(function* () {
      const transport = yield* Loops.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              success: false,
              message: "contact is suppressed"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "ada@example.com",
          subject: "Hi",
          providerTemplate: { id: "tmpl" }
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "ProviderRejected"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "ProviderRejected" &&
          result.failure.message,
        "contact is suppressed"
      )
    }))
})
