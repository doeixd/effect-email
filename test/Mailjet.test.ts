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
import * as Mailjet from "../src/providers/Mailjet"

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

const emailLayerFor = (transport: Mailjet.MailjetClient["transport"]) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

const options = {
  apiKey: Redacted.make("mj_public"),
  apiSecret: Redacted.make("mj_private")
} as const

describe("Mailjet", () => {
  it.effect("maps a message onto the v3.1 payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Mailjet.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(request.headers, "authorization"),
              body: bodyOf(request)
            }
            return respond(200, {
              Messages: [
                {
                  Status: "success",
                  To: [{ Email: "customer@example.com", MessageUUID: "mj_1" }]
                }
              ]
            })(request)
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
          headers: [["X-Campaign", "welcome"]]
        },
        { providerIdempotencyKey: "idem_1" }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v3.1/send"))
      assert.strictEqual(
        captured.authorization,
        `Basic ${Buffer.from("mj_public:mj_private").toString("base64")}`
      )
      assert.deepStrictEqual(captured.body, {
        Messages: [
          {
            From: { Email: "billing@example.com" },
            To: [{ Email: "customer@example.com" }],
            Cc: [{ Email: "cc@example.com" }],
            ReplyTo: { Email: "support@example.com" },
            Subject: "Your receipt",
            TextPart: "Receipt body",
            HTMLPart: "<p>Receipt body</p>",
            Headers: { "x-campaign": "welcome" },
            CustomID: "idem_1"
          }
        ]
      })
      assert.strictEqual(receipt.provider, "mailjet")
      assert.strictEqual(receipt.providerMessageId, providerMessageId("mj_1"))
    }))

  it.effect("keeps per-message results from a 400 batch response", () =>
    Effect.gen(function* () {
      const transport = yield* Mailjet.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              Messages: [
                {
                  Status: "success",
                  To: [{ Email: "one@example.com", MessageUUID: "mj_one" }]
                },
                {
                  Status: "error",
                  Errors: [
                    {
                      StatusCode: 400,
                      ErrorMessage: "invalid recipient"
                    }
                  ]
                }
              ]
            })
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

  it.effect("splits requests when the combined recipient cap is exceeded", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* Mailjet.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            const messages = bodyOf(request).Messages.map(
              (message: any, index: number) => ({
                Status: "success",
                To: [
                  {
                    Email: message.To[0].Email,
                    MessageUUID: `mj_${requests.length}_${index}`
                  }
                ]
              })
            )
            return respond(200, { Messages: messages })(request)
          })
        )
      )

      const recipients = Array.from(
        { length: 60 },
        (_, index) => `person${index}@example.com`
      )
      yield* Email.sendBatch([
        { to: recipients.slice(0, 20), subject: "Hi", text: "Body" },
        { to: recipients.slice(20, 40), subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].Messages.length, 2)

      requests.length = 0
      yield* Email.sendBatch([
        { to: recipients.slice(0, 30), subject: "Hi", text: "Body" },
        { to: recipients.slice(30, 60), subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 2)
      assert.strictEqual(requests[0].Messages.length, 1)
      assert.strictEqual(requests[1].Messages.length, 1)
    }))

  it.effect("marks a success without a provider id as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* Mailjet.make(options).pipe(
        Effect.provide(
          clientLayer(respond(200, { Messages: [{ Status: "success" }] }))
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "customer@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(outcomes[0]?._tag, "uncertain")
    }))
})

