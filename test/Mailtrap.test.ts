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
import * as Mailtrap from "../src/providers/Mailtrap"

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

const options = { apiKey: Redacted.make("mt-test") } as const

describe("Mailtrap", () => {
  it.effect("maps a message with category and tags", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Mailtrap.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              body: bodyOf(request)
            }
            return respond(200, {
              success: true,
              message_ids: ["mt_1"]
            })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        replyTo: "support@example.com",
        tags: ["category", "receipt"]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/api/send"))
      assert.deepStrictEqual(captured.body, {
        from: { email: "billing@example.com" },
        to: [{ email: "customer@example.com" }],
        reply_to: { email: "support@example.com" },
        subject: "Your receipt",
        category: "category",
        text: "Receipt body",
        custom_variables: { "tag_receipt": "true" }
      })
      assert.strictEqual(receipt.provider, "mailtrap")
      assert.strictEqual(receipt.providerMessageId, providerMessageId("mt_1"))
    }))

  it.effect("sends a native batch and maps each response", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* Mailtrap.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return respond(200, {
              success: true,
              responses: [
                { success: true, message_ids: ["mt_one"] },
                { success: true, message_ids: ["mt_two"] }
              ]
            })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].requests.length, 2)
      assert.deepStrictEqual(requests[0].base, {
        from: { email: "billing@example.com" }
      })
      assert.deepStrictEqual(
        outcomes.map(
          (outcome) =>
            outcome._tag === "accepted" && outcome.receipt.providerMessageId
        ),
        [providerMessageId("mt_one"), providerMessageId("mt_two")]
      )
    }))

  it.effect("routes to the sandbox inbox", () =>
    Effect.gen(function* () {
      let url: string | undefined
      const transport = yield* Mailtrap.make({
        ...options,
        sandbox: true,
        inboxId: 12345
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            url = request.url
            return respond(200, {
              success: true,
              message_ids: ["mt_sandbox"]
            })(request)
          })
        )
      )

      yield* Email.send({
        to: "customer@example.com",
        subject: "Hi",
        text: "Body"
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(
        url,
        "https://sandbox.api.mailtrap.io/api/send/12345"
      )
    }))

  it.effect("rejects a sandbox send without an inbox id", () =>
    Effect.gen(function* () {
      const transport = yield* Mailtrap.make({
        ...options,
        sandbox: true
      }).pipe(Effect.provide(clientLayer(respond(200, {}))))

      const result = yield* Effect.result(
        Email.send({
          to: "customer@example.com",
          subject: "Hi",
          text: "Body"
        }).pipe(Effect.provide(emailLayerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "UnsupportedCapability"
      )
    }))
})

