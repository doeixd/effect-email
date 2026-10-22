import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import { providerMessageId } from "../src/Ids"
import type { Transport } from "../src/EmailTransport"
import * as Smtp2go from "../src/providers/Smtp2go"

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

const emailLayerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

const options = { apiKey: Redacted.make("api-test"), region: "eu" } as const

describe("SMTP2GO", () => {
  it.effect("maps a message and forwards remote attachments", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Smtp2go.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = { url: request.url, body: bodyOf(request) }
            return respond(200, {
              request_id: "req_1",
              data: { succeeded: 1, failed: 0, email_id: "smtp_1" }
            })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        replyTo: "support@example.com",
        tags: ["receipt"],
        attachments: [
          {
            filename: "invoice.pdf",
            source: {
              _tag: "url",
              url: "https://example.com/invoice.pdf"
            }
          }
        ]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.startsWith("https://eu-api.smtp2go.com"))
      assert.isTrue(captured.url.endsWith("/v3/email/send"))
      assert.deepStrictEqual(captured.body, {
        sender: "billing@example.com",
        to: ["customer@example.com"],
        subject: "Your receipt",
        text_body: "Receipt body",
        custom_headers: [
          { header: "Reply-To", value: "support@example.com" },
          { header: "X-Tag-receipt", value: "true" }
        ],
        attachments: [
          {
            filename: "invoice.pdf",
            url: "https://example.com/invoice.pdf"
          }
        ]
      })
      assert.strictEqual(receipt.provider, "smtp2go")
      assert.strictEqual(receipt.requestId, "req_1")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("smtp_1")
      )
    }))

  it.effect("treats a failed 200 response as a rejection", () =>
    Effect.gen(function* () {
      const transport = yield* Smtp2go.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              data: {
                succeeded: 0,
                failed: 1,
                failures: ["customer@example.com: mailbox unavailable"]
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
          result.failure.retryable,
        false
      )
    }))

  it.effect("marks a success without an email id as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* Smtp2go.make(options).pipe(
        Effect.provide(clientLayer(respond(200, { data: { succeeded: 1 } })))
      )

      const outcomes = yield* Email.sendBatch([
        { to: "customer@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(outcomes[0]?._tag, "uncertain")
    }))

  it.effect("maps a rejected key reported as a 400", () =>
    Effect.gen(function* () {
      const transport = yield* Smtp2go.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              data: {
                error: "API key is invalid",
                error_code: "E_ApiResponseCodes/API_KEY_INVALID"
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
        "AuthenticationFailed"
      )
    }))
})

