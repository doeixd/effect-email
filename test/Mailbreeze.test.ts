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
import * as Mailbreeze from "../src/providers/Mailbreeze"

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

const options = { apiKey: Redacted.make("sk_test_mailbreeze") } as const

describe("Mailbreeze", () => {
  it.effect("maps a message onto the email payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Mailbreeze.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              apiKey: headerValue(request.headers, "x-api-key"),
              body: bodyOf(request)
            }
            return respond(200, {
              success: true,
              data: { id: "mail_one", sandbox: true }
            })(request)
          })
        )
      )

      const receipt = yield* Email.send(
        {
          to: "customer@example.com",
          cc: "cc@example.com",
          bcc: "bcc@example.com",
          subject: "Your receipt",
          text: "Receipt body",
          html: "<p>Receipt body</p>",
          replyTo: ["support@example.com", "Care Team <care@example.com>"],
          headers: [["X-Campaign", "welcome"]]
        },
        { providerIdempotencyKey: "idem-1" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v1/emails"))
      assert.strictEqual(captured.apiKey, "sk_test_mailbreeze")
      assert.deepStrictEqual(captured.body, {
        from: "billing@example.com",
        to: ["customer@example.com"],
        subject: "Your receipt",
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        replyTo: "support@example.com, Care Team <care@example.com>",
        headers: { "x-campaign": "welcome" },
        idempotencyKey: "idem-1"
      })
      assert.strictEqual(receipt.provider, "mailbreeze")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("mail_one")
      )
    }))

  it.effect("passes a provider template and its variables", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Mailbreeze.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = bodyOf(request)
            return respond(200, {
              success: true,
              data: { id: "mail_two", sandbox: true }
            })(request)
          })
        )
      )

      yield* Email.send({
        to: "customer@example.com",
        subject: "Your receipt",
        providerTemplate: {
          id: "receipt-template",
          variables: { name: "Ada", total: 42 }
        }
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.deepStrictEqual(captured, {
        from: "billing@example.com",
        to: ["customer@example.com"],
        subject: "Your receipt",
        templateId: "receipt-template",
        variables: { name: "Ada", total: 42 }
      })
    }))

  it.effect("surfaces a nested provider error", () =>
    Effect.gen(function* () {
      const transport = yield* Mailbreeze.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              success: false,
              error: {
                code: "INVALID_RECIPIENT",
                message: "recipient is suppressed"
              }
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
        "recipient is suppressed"
      )
    }))

  it.effect("does not treat a disabled sending domain as an auth failure", () =>
    Effect.gen(function* () {
      const transport = yield* Mailbreeze.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(403, {
              success: false,
              error: {
                code: "SENDING_DISABLED",
                message: "sending is disabled for this domain"
              }
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
    }))
})
