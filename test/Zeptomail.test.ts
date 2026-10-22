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
import * as Zeptomail from "../src/providers/Zeptomail"

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

const options = {
  token: Redacted.make("zoho-token"),
  bounceAddress: "bounce@example.com"
} as const

describe("ZeptoMail", () => {
  it.effect("maps a message onto the v1.1 payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Zeptomail.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = { url: request.url, body: bodyOf(request) }
            return respond(201, { request_id: "zepto_1" })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        cc: "cc@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        replyTo: "support@example.com",
        tags: ["receipt"]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v1.1/email"))
      assert.deepStrictEqual(captured.body, {
        from: { address: "billing@example.com" },
        to: [{ email_address: { address: "customer@example.com" } }],
        cc: [{ email_address: { address: "cc@example.com" } }],
        reply_to: [{ address: "support@example.com" }],
        subject: "Your receipt",
        textbody: "Receipt body",
        mime_headers: { "X-Tag-receipt": "true" },
        bounce_address: "bounce@example.com"
      })
      assert.strictEqual(receipt.provider, "zeptomail")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("zepto_1")
      )
    }))

  it.effect("fans compatible messages into one batch request", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* Zeptomail.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return respond(201, { request_id: "zepto_batch" })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.deepStrictEqual(requests[0].to, [
        { email_address: { address: "one@example.com" } },
        { email_address: { address: "two@example.com" } }
      ])
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.deepStrictEqual(
        outcomes.map(
          (outcome) =>
            outcome._tag === "accepted" && outcome.receipt.providerMessageId
        ),
        [
          providerMessageId("zepto_batch"),
          providerMessageId("zepto_batch")
        ]
      )
    }))

  it.effect("sends provider templates with merge info", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Zeptomail.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = { url: request.url, body: bodyOf(request) }
            return respond(201, { request_id: "zepto_tpl" })(request)
          })
        )
      )

      yield* Email.send({
        to: "customer@example.com",
        subject: "Template",
        providerTemplate: { id: "tpl_1", variables: { name: "Ada" } }
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v1.1/email/template"))
      assert.strictEqual(captured.body.template_key, "tpl_1")
      assert.deepStrictEqual(captured.body.to, [
        {
          email_address: { address: "customer@example.com" },
          merge_info: { name: "Ada" }
        }
      ])
    }))

  it.effect("maps auth detail codes on a 400", () =>
    Effect.gen(function* () {
      const transport = yield* Zeptomail.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              error: {
                code: "TM_3201",
                message: "invalid token",
                details: [{ code: "SM_111", message: "token rejected" }]
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
