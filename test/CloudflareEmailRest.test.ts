import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import type { Transport } from "../src/EmailTransport"
import * as Cloudflare from "../src/providers/CloudflareEmailRest"

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
  accountId: "account-1",
  apiToken: Redacted.make("cf-token")
} as const

describe("CloudflareEmailRest", () => {
  it.effect("maps a message onto the send payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Cloudflare.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              body: bodyOf(request)
            }
            return respond(200, {
              success: true,
              result: {
                queued: ["customer@example.com"],
                delivered: [],
                permanent_bounces: [],
                message_id: "cf-message-1"
              }
            })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        replyTo: "support@example.com",
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

      assert.isTrue(
        captured.url.endsWith(
          "/client/v4/accounts/account-1/email/sending/send"
        )
      )
      assert.strictEqual(captured.authorization, "Bearer cf-token")
      assert.deepStrictEqual(captured.body, {
        from: { address: "billing@example.com" },
        to: [{ address: "customer@example.com" }],
        cc: [{ address: "cc@example.com" }],
        bcc: [{ address: "bcc@example.com" }],
        reply_to: { address: "support@example.com" },
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        headers: { "x-campaign": "welcome" },
        attachments: [
          {
            content: "aGVsbG8=",
            filename: "notes.txt",
            type: "text/plain",
            disposition: "attachment"
          }
        ]
      })
      assert.strictEqual(receipt.provider, "cloudflare-email-rest")
      assert.strictEqual(
        receipt.providerMessageId,
        "cf-message-1"
      )
    }))

  it.effect("treats success false as a rejection", () =>
    Effect.gen(function* () {
      const transport = yield* Cloudflare.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              success: false,
              errors: [{ code: 10200, message: "invalid recipient" }]
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
        "ProviderRejected"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "ProviderRejected" &&
          result.failure.message,
        "invalid recipient"
      )
    }))

  it.effect("reports a partial permanent bounce as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* Cloudflare.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              success: true,
              result: {
                queued: ["ok@example.com"],
                permanent_bounces: ["bad@example.com"]
              }
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: ["ok@example.com", "bad@example.com"],
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "DeliveryUncertain"
      )
    }))

  it.effect("maps an API auth code to AuthenticationFailed", () =>
    Effect.gen(function* () {
      const transport = yield* Cloudflare.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(403, {
              success: false,
              errors: [{ code: 10101, message: "token is not authorized" }]
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
        "AuthenticationFailed"
      )
    }))
})
