import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import { certaintyOf } from "../src/EmailError"
import { providerMessageId } from "../src/Ids"
import * as Postmark from "../src/providers/Postmark"

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

const emailLayerFor = (transport: Postmark.PostmarkClient["transport"]) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("Postmark", () => {
  it.effect("maps a message onto the Postmark payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Postmark.make({
        apiKey: Redacted.make("pm_test")
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              token: headerValue(
                request.headers,
                "x-postmark-server-token"
              ),
              body: bodyOf(request)
            }
            return respond(200, {
              MessageID: "pm_1",
              ErrorCode: 0,
              Message: "OK",
              SubmittedAt: "2026-01-01T00:00:00Z"
            })(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "customer@example.com",
        cc: "cc@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        replyTo: "support@example.com",
        tags: [],
        headers: [["X-Campaign", "welcome"]]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/email"))
      assert.strictEqual(captured.token, "pm_test")
      assert.deepStrictEqual(captured.body, {
        From: "billing@example.com",
        To: "customer@example.com",
        Cc: "cc@example.com",
        Subject: "Your receipt",
        TextBody: "Receipt body",
        HtmlBody: "<p>Receipt body</p>",
        ReplyTo: "support@example.com",
        Headers: [{ Name: "x-campaign", Value: "welcome" }],
        MessageStream: "outbound"
      })
      assert.strictEqual(receipt.provider, "postmark")
      assert.strictEqual(receipt.providerMessageId, providerMessageId("pm_1"))
    }))

  it.effect("classifies HTTP failures", () =>
    Effect.gen(function* () {
      const unauthorized = yield* Postmark.make({
        apiKey: Redacted.make("pm_bad")
      }).pipe(
        Effect.provide(
          clientLayer(respond(401, { ErrorCode: 10, Message: "bad token" }))
        ),
        Effect.flatMap((transport) =>
          Email.send({
            to: "customer@example.com",
            subject: "Hi",
            text: "Body"
          }).pipe(Effect.provide(emailLayerFor(transport)))
        ),
        Effect.flip
      )

      assert.strictEqual(unauthorized._tag, "AuthenticationFailed")
      assert.strictEqual(certaintyOf(unauthorized), "rejected")
    }))

  it.effect("reads per-message errors from a 200 batch response", () =>
    Effect.gen(function* () {
      const transport = yield* Postmark.make({
        apiKey: Redacted.make("pm_test")
      }).pipe(
        Effect.provide(
          clientLayer(
            respond(200, [
              {
                ErrorCode: 0,
                Message: "OK",
                MessageID: "pm_one",
                SubmittedAt: "2026-01-01T00:00:00Z",
                To: "one@example.com"
              },
              {
                ErrorCode: 406,
                Message: "recipient inactive"
              }
            ])
          )
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "rejected"]
      )
      const rejected = outcomes[1]!
      assert.strictEqual(
        rejected._tag === "rejected" && rejected.error._tag,
        "ProviderRejected"
      )
    }))

  it.effect("marks missing batch positions as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* Postmark.make({
        apiKey: Redacted.make("pm_test")
      }).pipe(
        Effect.provide(
          clientLayer(
            respond(200, [
              {
                ErrorCode: 0,
                Message: "OK",
                MessageID: "pm_one",
                SubmittedAt: "2026-01-01T00:00:00Z"
              }
            ])
          )
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "uncertain"]
      )
    }))

  it.effect("maps a validation error to a definite rejection", () =>
    Effect.gen(function* () {
      const transport = yield* Postmark.make({
        apiKey: Redacted.make("pm_test")
      }).pipe(
        Effect.provide(
          clientLayer(
            respond(422, {
              ErrorCode: 300,
              Message: "invalid to address"
            })
          )
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "customer@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(outcomes[0]?._tag, "rejected")
      assert.strictEqual(
        outcomes[0]?._tag === "rejected" && outcomes[0].error._tag,
        "ProviderRejected"
      )
    }))
})
