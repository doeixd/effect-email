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
import * as SendGrid from "../src/providers/SendGrid"

const respond = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body === null ? null : JSON.stringify(body), {
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

const layer = (token = "SG.test") =>
  SendGrid.layer({ apiKey: Redacted.make(token) }).pipe(
    Layer.provide(clientLayer(respond(202, null, { "x-message-id": "sg_1" })))
  )

describe("SendGrid", () => {
  it.effect("maps a rendered message onto the v3 payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* SendGrid.make({
        apiKey: Redacted.make("SG.test")
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              body: bodyOf(request)
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 202,
                  headers: { "x-message-id": "sg_1" }
                })
              )
            )
          })
        )
      )
      const receipt = yield* Email.send({
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Receipt body",
        html: "<p>Receipt body</p>",
        replyTo: "support@example.com",
        tags: ["receipt", "transactional"],
        headers: [["X-Campaign", "welcome"]]
      }).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.isTrue(captured.url.endsWith("/v3/mail/send"))
      assert.strictEqual(captured.authorization, "Bearer SG.test")
      assert.deepStrictEqual(captured.body.from, {
        email: "billing@example.com"
      })
      assert.deepStrictEqual(captured.body.personalizations, [
        {
          to: [{ email: "customer@example.com" }],
          subject: "Your receipt"
        }
      ])
      assert.deepStrictEqual(captured.body.content, [
        { type: "text/plain", value: "Receipt body" },
        { type: "text/html", value: "<p>Receipt body</p>" }
      ])
      assert.deepStrictEqual(captured.body.reply_to, {
        email: "support@example.com"
      })
      assert.deepStrictEqual(captured.body.categories, [
        "receipt",
        "transactional"
      ])
      assert.deepStrictEqual(captured.body.headers, {
        "x-campaign": "welcome"
      })
      assert.strictEqual(receipt.provider, "sendgrid")
      assert.strictEqual(receipt.providerMessageId, "sg_1")
    }))

  it.effect("classifies auth and rate-limit failures", () =>
    Effect.gen(function* () {
      const unauthorized = yield* SendGrid.make({
        apiKey: Redacted.make("SG.bad")
      }).pipe(
        Effect.provide(clientLayer(respond(401, { errors: [{ message: "bad key" }] }))),
        Effect.flatMap((transport) =>
          Email.send({
            to: "customer@example.com",
            subject: "Hi",
            text: "Body"
          }).pipe(
            Effect.provide(
              Email.layer({
                defaultFrom: "billing@example.com",
                routes: { default: transport }
              })
            )
          )
        ),
        Effect.flip
      )
      assert.strictEqual(unauthorized._tag, "AuthenticationFailed")
      assert.strictEqual(certaintyOf(unauthorized), "rejected")

      const limited = yield* SendGrid.make({
        apiKey: Redacted.make("SG.test")
      }).pipe(
        Effect.provide(
          clientLayer(
            respond(429, { errors: [{ message: "slow down" }] }, { "retry-after": "1" })
          )
        ),
        Effect.flatMap((transport) =>
          Email.send({
            to: "customer@example.com",
            subject: "Hi",
            text: "Body"
          }).pipe(
            Effect.provide(
              Email.layer({
                defaultFrom: "billing@example.com",
                routes: { default: transport }
              })
            )
          )
        ),
        Effect.flip
      )
      assert.strictEqual(limited._tag, "RateLimited")
      if (limited._tag === "RateLimited") {
        assert.strictEqual(limited.retryAfterMillis, 1000)
      }
    }))

  it.effect("uses one personalization request for a compatible batch", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* SendGrid.make({
        apiKey: Redacted.make("SG.test")
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 202,
                  headers: { "x-message-id": "sg_batch" }
                })
              )
            )
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Same", text: "Body" },
        { to: "two@example.com", subject: "Same", text: "Body" }
      ]).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].personalizations.length, 2)
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.strictEqual(
        outcomes[0]!._tag === "accepted" &&
          outcomes[0]!.receipt.providerMessageId,
        providerMessageId("sg_batch")
      )
    }))

  it.effect("splits a group when a recipient repeats", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* SendGrid.make({
        apiKey: Redacted.make("SG.test")
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 202,
                  headers: { "x-message-id": `sg_${requests.length}` }
                })
              )
            )
          })
        )
      )

      yield* Email.sendBatch([
        { to: "one@example.com", subject: "Same", text: "Body" },
        { to: "one@example.com", subject: "Same", text: "Body" }
      ]).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.strictEqual(requests.length, 2)
      assert.strictEqual(requests[0].personalizations.length, 1)
      assert.strictEqual(requests[1].personalizations.length, 1)
    }))
})

