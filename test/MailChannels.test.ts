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
import * as MailChannels from "../src/providers/MailChannels"

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

const options = { apiKey: Redacted.make("mc-key") } as const

describe("MailChannels", () => {
  it.effect("maps a message onto a personalization", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* MailChannels.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              apiKey: headerValue(request.headers, "x-api-key"),
              body: bodyOf(request)
            }
            return respond(200, {
              request_id: "req-1",
              results: [{ index: 0, message_id: "mc_one" }]
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
        tags: ["receipt"]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/tx/v1/send"))
      assert.strictEqual(captured.apiKey, "mc-key")
      assert.deepStrictEqual(captured.body, {
        content: [
          { type: "text/plain", value: "Receipt body" },
          { type: "text/html", value: "<p>Receipt body</p>" }
        ],
        from: { email: "billing@example.com" },
        subject: "Your receipt",
        personalizations: [
          {
            to: [{ email: "customer@example.com" }],
            from: { email: "billing@example.com" },
            subject: "Your receipt",
            cc: [{ email: "cc@example.com" }],
            bcc: [{ email: "bcc@example.com" }],
            reply_to: { email: "support@example.com" },
            headers: {
              "x-campaign": "welcome",
              "X-Tag-receipt": "true"
            }
          }
        ]
      })
      assert.strictEqual(receipt.provider, "mailchannels")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("mc_one")
      )
    }))

  it.effect("shares one request across compatible messages", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* MailChannels.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return respond(200, {
              request_id: "req-2",
              results: [
                { index: 0, message_id: "mc_one" },
                { index: 1, message_id: "mc_two" }
              ]
            })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        {
          to: "one@example.com",
          subject: "First",
          text: "Shared body"
        },
        {
          to: "two@example.com",
          subject: "Second",
          text: "Shared body"
        }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].personalizations.length, 2)
      assert.deepStrictEqual(
        requests[0].personalizations.map((entry: any) => entry.subject),
        ["First", "Second"]
      )
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.strictEqual(
        outcomes[0]?._tag === "accepted" &&
          outcomes[0].receipt.providerMessageId,
        providerMessageId("mc_one")
      )
    }))

  it.effect("turns a failed result entry into a rejection", () =>
    Effect.gen(function* () {
      const transport = yield* MailChannels.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(200, {
              request_id: "req-3",
              results: [
                {
                  index: 0,
                  status: "failed",
                  reason: "recipient is suppressed"
                }
              ]
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

  it.effect("classifies a 403 as an authentication failure", () =>
    Effect.gen(function* () {
      const transport = yield* MailChannels.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(403, { errors: ["api key is not authorized"] })
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
