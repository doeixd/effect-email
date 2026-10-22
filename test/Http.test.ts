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
import * as Http from "../src/providers/Http"

const respond =
  (status: number, body?: unknown) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          body === undefined ? null : JSON.stringify(body),
          {
            status,
            headers: { "content-type": "application/json" }
          }
        )
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

describe("Http", () => {
  it.effect("lets the caller own the request and extract the id", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Http.make({
        endpoint: "https://gateway.internal/v1/send",
        auth: { type: "bearer", token: Redacted.make("gateway-token") },
        headers: (message, context) => ({
          "x-message-id": message.subject,
          "x-idempotency-key": context.providerIdempotencyKey ?? ""
        }),
        body: (message, context) => ({
          rcpt: message.to.map((address) => address.address),
          subj: message.subject,
          idem: context.providerIdempotencyKey
        }),
        extractId: (body) => (body as { ref?: string }).ref
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              method: request.method,
              authorization: headerValue(request.headers, "authorization"),
              messageId: headerValue(request.headers, "x-message-id"),
              idempotencyKey: headerValue(
                request.headers,
                "x-idempotency-key"
              ),
              contentType: headerValue(request.headers, "content-type"),
              body: bodyOf(request)
            }
            return respond(202, { ref: "gateway_42" })(request)
          })
        )
      )

      const receipt = yield* Email.send(
        {
          to: "customer@example.com",
          subject: "Welcome",
          text: "Hello"
        },
        { providerIdempotencyKey: "idem-9" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(captured.url, "https://gateway.internal/v1/send")
      assert.strictEqual(captured.method, "POST")
      assert.strictEqual(captured.authorization, "Bearer gateway-token")
      assert.strictEqual(captured.messageId, "Welcome")
      assert.strictEqual(captured.idempotencyKey, "idem-9")
      assert.strictEqual(captured.contentType, "application/json")
      assert.deepStrictEqual(captured.body, {
        rcpt: ["customer@example.com"],
        subj: "Welcome",
        idem: "idem-9"
      })
      assert.strictEqual(receipt.provider, "http")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("gateway_42")
      )
    }))

  it.effect("sends the normalized message by default", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Http.make({
        endpoint: "https://gateway.internal/v1/send",
        extractId: () => "gateway_default"
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = bodyOf(request)
            return respond(200, { id: "gateway_default" })(request)
          })
        )
      )

      yield* Email.send({
        to: "customer@example.com",
        subject: "Receipt",
        text: "Receipt body",
        tags: ["transactional"],
        headers: [["X-Campaign", "welcome"]],
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
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.deepStrictEqual(captured.from, { email: "billing@example.com" })
      assert.deepStrictEqual(captured.to, [
        { email: "customer@example.com" }
      ])
      assert.deepStrictEqual(captured.content, {
        _tag: "rendered",
        text: "Receipt body"
      })
      assert.deepStrictEqual(captured.tags, ["transactional"])
      assert.deepStrictEqual(captured.headers, { "x-campaign": "welcome" })
      assert.deepStrictEqual(captured.attachments, [
        {
          filename: "notes.txt",
          content: "aGVsbG8=",
          encoding: "base64",
          contentType: "text/plain",
          disposition: "attachment"
        }
      ])
    }))

  it.effect("honours a custom failure classification", () =>
    Effect.gen(function* () {
      const transport = yield* Http.make({
        endpoint: "https://gateway.internal/v1/send",
        classify: (status) =>
          status === 502
            ? {
                class: "uncertain" as const,
                message: "gateway accepted the message but could not confirm"
              }
            : null
      }).pipe(
        Effect.provide(
          clientLayer((request) => respond(502, { message: "bad gateway" })(request))
        )
      )

      const error = yield* Email.send({
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hello"
      }).pipe(
        Effect.provide(emailLayerFor(transport)),
        Effect.flip
      )

      assert.strictEqual(error._tag, "DeliveryUncertain")
      if (error._tag === "DeliveryUncertain") {
        assert.strictEqual(
          error.message,
          "gateway accepted the message but could not confirm"
        )
      }
    }))

  it.effect("accepts an empty success response with a local id", () =>
    Effect.gen(function* () {
      const transport = yield* Http.make({
        endpoint: "https://gateway.internal/v1/send"
      }).pipe(
        Effect.provide(clientLayer((request) => respond(202)(request)))
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hello"
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(receipt.provider, "http")
      assert.isTrue(receipt.providerMessageId?.startsWith("gateway_"))
    }))
})
