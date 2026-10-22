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
import * as MailerSend from "../src/providers/MailerSend"

const respond = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
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

const options = { apiKey: Redacted.make("ms_token") } as const

describe("MailerSend", () => {
  it.effect("maps a message onto the v1 payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              body: bodyOf(request)
            }
            return respond(202, {}, { "x-message-id": "ms_1" })(request)
          })
        )
      )

      const receipt = yield* Email.send(
        {
          to: "customer@example.com",
          cc: "cc@example.com",
          subject: "Your receipt",
          text: "Receipt body",
          html: "<p>Receipt body</p>",
          replyTo: "support@example.com",
          headers: [["X-Campaign", "welcome"]],
          tags: ["receipt"]
        },
        { providerIdempotencyKey: "idem_1" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v1/email"))
      assert.strictEqual(captured.authorization, "Bearer ms_token")
      assert.deepStrictEqual(captured.body, {
        from: { email: "billing@example.com" },
        to: [{ email: "customer@example.com" }],
        cc: [{ email: "cc@example.com" }],
        reply_to: { email: "support@example.com" },
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        headers: [{ name: "x-campaign", value: "welcome" }],
        tags: ["receipt"]
      })
      assert.strictEqual(receipt.provider, "mailersend")
      assert.strictEqual(receipt.providerMessageId, providerMessageId("ms_1"))
    }))

  it.effect("rejects messages over MailerSend CC, BCC, or tag limits", () =>
    Effect.gen(function* () {
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(
          clientLayer(respond(202, {}, { "x-message-id": "ms_1" }))
        )
      )
      const layer = emailLayerFor(transport)

      const cc = yield* Effect.result(
        Email.send({
          to: "one@example.com",
          cc: Array.from({ length: 11 }, (_, index) => `cc${index}@example.com`),
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(layer))
      )
      const tags = yield* Effect.result(
        Email.send({
          to: "one@example.com",
          subject: "Hi",
          text: "Body",
          tags: ["a", "b", "c", "d", "e", "f"]
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(
        cc._tag === "Failure" && cc.failure._tag,
        "UnsupportedCapability"
      )
      assert.strictEqual(
        tags._tag === "Failure" && tags.failure._tag,
        "UnsupportedCapability"
      )
    }))

  it.effect("sends a native bulk request and shares the bulk id", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return respond(202, { bulk_email_id: "bulk_1" })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].length, 2)
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.deepStrictEqual(
        outcomes.map(
          (outcome) =>
            outcome._tag === "accepted" &&
            outcome.receipt.providerMessageId
        ),
        [providerMessageId("bulk_1"), providerMessageId("bulk_1")]
      )
    }))

  it.effect("surfaces flattened validation errors", () =>
    Effect.gen(function* () {
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(422, {
              message: "Unprocessable Entity",
              errors: { to: ["invalid recipient"] }
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

      assert.strictEqual(result._tag, "Failure")
      assert.strictEqual(result._tag === "Failure" && result.failure._tag, "ProviderRejected")
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "ProviderRejected" &&
          result.failure.message,
        "to: invalid recipient"
      )
    }))

  it.effect("marks a success without a provider id as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(clientLayer(respond(202, {})))
      )

      const outcomes = yield* Email.sendBatch([
        { to: "customer@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(outcomes[0]?._tag, "uncertain")
    }))

  it.effect("retrieves message status", () =>
    Effect.gen(function* () {
      let url = ""
      const client = yield* MailerSend.makeClient(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            url = request.url
            return respond(200, {
              data: {
                id: "ms_1",
                created_at: "2026-01-01T00:00:00.000Z",
                emails: [{ status: "delivered" }]
              }
            })(request)
          })
        )
      )

      const status = yield* client.retrieve(providerMessageId("ms_1"))

      assert.isTrue(url.endsWith("/v1/messages/ms_1"))
      assert.strictEqual(status.id, providerMessageId("ms_1"))
      assert.strictEqual(status.state, "delivered")
      assert.isDefined(status.at)
    }))

  it.effect("falls back to bulk status when a message id is not found", () =>
    Effect.gen(function* () {
      const urls: Array<string> = []
      const client = yield* MailerSend.makeClient(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            urls.push(request.url)
            if (request.url.endsWith("/v1/messages/bulk_1")) {
              return respond(404, { message: "Not Found" })(request)
            }
            return respond(200, {
              data: {
                id: "bulk_1",
                state: "processing",
                created_at: "2026-01-01T00:00:00.000Z"
              }
            })(request)
          })
        )
      )

      const status = yield* client.retrieve(providerMessageId("bulk_1"))

      assert.deepStrictEqual(urls, [
        "https://api.mailersend.com/v1/messages/bulk_1",
        "https://api.mailersend.com/v1/bulk-email/bulk_1"
      ])
      assert.strictEqual(status.id, providerMessageId("bulk_1"))
      assert.strictEqual(status.state, "queued")
    }))

  it.effect("retrieves through the email service by receipt destination", () =>
    Effect.gen(function* () {
      const transport = yield* MailerSend.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            if (request.url.endsWith("/v1/email")) {
              return respond(202, {}, { "x-message-id": "ms_1" })(
                request
              )
            }
            if (request.url.endsWith("/v1/messages/ms_1")) {
              return respond(200, {
                data: {
                  id: "ms_1",
                  emails: [{ status: "delivered" }]
                }
              })(request)
            }
            return respond(404, {})(request)
          })
        )
      )
      const layer = emailLayerFor(transport)
      const receipt = yield* Email.send({
        to: "customer@example.com",
        subject: "Hi",
        text: "Body"
      }).pipe(Effect.provide(layer))

      const status = yield* Email.retrieve(receipt).pipe(
        Effect.provide(layer)
      )

      assert.strictEqual(status.provider, "mailersend")
      assert.strictEqual(status.state, "delivered")
      assert.strictEqual(
        status.providerMessageId,
        providerMessageId("ms_1")
      )
    }))
})

