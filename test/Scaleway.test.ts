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
import * as Scaleway from "../src/providers/Scaleway"

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
  secretKey: Redacted.make("scw-secret"),
  projectId: "project-1"
} as const

describe("Scaleway", () => {
  it.effect("maps a message onto the transactional payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Scaleway.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = { url: request.url, body: bodyOf(request) }
            return respond(200, {
              emails: [
                { id: "scw_one", status: "new" },
                { id: "scw_two", status: "new" }
              ]
            })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: ["one@example.com", "two@example.com"],
        cc: "cc@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        replyTo: "support@example.com",
        headers: [["X-Campaign", "welcome"]]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(
        captured.url.endsWith(
          "/transactional-email/v1alpha1/regions/fr-par/emails"
        )
      )
      assert.deepStrictEqual(captured.body, {
        from: { email: "billing@example.com" },
        to: [{ email: "one@example.com" }, { email: "two@example.com" }],
        cc: [{ email: "cc@example.com" }],
        project_id: "project-1",
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        additional_headers: [
          { key: "x-campaign", value: "welcome" },
          { key: "Reply-To", value: "support@example.com" }
        ]
      })
      assert.strictEqual(receipt.provider, "scaleway")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("scw_one")
      )
    }))

  it.effect("classifies a quota 403 as a non-retryable rate limit", () =>
    Effect.gen(function* () {
      const transport = yield* Scaleway.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(403, {
              type: "quotas_exceeded",
              message: "monthly quota exceeded"
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
        false
      )
    }))

  it.effect("flattens invalid argument details", () =>
    Effect.gen(function* () {
      const transport = yield* Scaleway.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              type: "invalid_arguments",
              message: "invalid arguments",
              details: [
                {
                  argument_name: "to",
                  reason: "must contain at least one address"
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
        "invalid arguments: to must contain at least one address"
      )
    }))
})
