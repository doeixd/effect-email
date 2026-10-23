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
import * as Brevo from "../src/providers/Brevo"

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

const options = { apiKey: Redacted.make("xkeysib-test") } as const

describe("Brevo", () => {
  it.effect("maps a message onto the transactional payload", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              apiKey: headerValue(request.headers, "api-key"),
              body: bodyOf(request)
            }
            return respond(201, { messageId: "brevo_1" })(request)
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
        headers: [["X-Campaign", "welcome"]],
        tags: ["receipt"]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v3/smtp/email"))
      assert.strictEqual(captured.apiKey, "xkeysib-test")
      assert.deepStrictEqual(captured.body, {
        sender: { email: "billing@example.com" },
        to: [{ email: "customer@example.com" }],
        cc: [{ email: "cc@example.com" }],
        replyTo: { email: "support@example.com" },
        subject: "Your receipt",
        htmlContent: "<p>Receipt body</p>",
        textContent: "Receipt body",
        headers: { "x-campaign": "welcome" },
        tags: ["receipt"]
      })
      assert.strictEqual(receipt.provider, "brevo")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("brevo_1")
      )
    }))

  it.effect("batches compatible messages as messageVersions", () =>
    Effect.gen(function* () {
      const requests: Array<any> = []
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            requests.push(bodyOf(request))
            return respond(201, {
              messageIds: ["brevo_one", "brevo_two"]
            })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "First", text: "One" },
        { to: "two@example.com", subject: "Second", text: "Two" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].messageVersions.length, 2)
      assert.strictEqual(requests[0].to, undefined)
      assert.strictEqual(requests[0].subject, undefined)
      assert.deepStrictEqual(requests[0].messageVersions, [
        {
          to: [{ email: "one@example.com" }],
          subject: "First",
          textContent: "One"
        },
        {
          to: [{ email: "two@example.com" }],
          subject: "Second",
          textContent: "Two"
        }
      ])
      assert.deepStrictEqual(
        outcomes.map(
          (outcome) =>
            outcome._tag === "accepted" && outcome.receipt.providerMessageId
        ),
        [providerMessageId("brevo_one"), providerMessageId("brevo_two")]
      )
    }))

  it.effect("hashes a free-form idempotency key into a stable UUID", () =>
    Effect.gen(function* () {
      const keys: Array<string | undefined> = []
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            keys.push(bodyOf(request)?.headers?.idempotencyKey)
            return respond(201, { messageId: "brevo_1" })(request)
          })
        )
      )
      const emailLayer = emailLayerFor(transport)
      const message = {
        to: "one@example.com",
        subject: "Hi",
        text: "Body"
      } as const

      yield* Email.send(message, {
        providerIdempotencyKey: "welcome:42"
      }).pipe(Effect.provide(emailLayer))
      yield* Email.send(message, {
        providerIdempotencyKey: "welcome:42"
      }).pipe(Effect.provide(emailLayer))

      assert.match(
        keys[0]!,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      assert.strictEqual(keys[0], keys[1])
    }))

  it.effect("hashes a batch idempotency key into one request key", () =>
    Effect.gen(function* () {
      const keys: Array<string | undefined> = []
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            keys.push(bodyOf(request)?.headers?.idempotencyKey)
            return respond(201, {
              messageIds: ["brevo_one", "brevo_two"]
            })(request)
          })
        )
      )
      const key = "123e4567-e89b-42d3-a456-426614174000"

      yield* Email.sendBatch(
        [
          { to: "one@example.com", subject: "First", text: "One" },
          { to: "two@example.com", subject: "Second", text: "Two" }
        ],
        { providerIdempotencyKey: key }
      ).pipe(Effect.provide(emailLayerFor(transport)))

      yield* Email.sendBatch([
        { to: "one@example.com", subject: "First", text: "One" },
        { to: "two@example.com", subject: "Second", text: "Two" }
      ], { providerIdempotencyKey: key }).pipe(Effect.provide(emailLayerFor(transport)))
      assert.strictEqual(keys.length, 2)
      assert.strictEqual(keys[0], keys[1])
      assert.match(
        keys[0]!,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      assert.notStrictEqual(keys[0], key)
    }))

  it.effect("maps unauthorized error codes regardless of status", () =>
    Effect.gen(function* () {
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              code: "unauthorized",
              message: "Key not authorized"
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

  it.effect("marks a short id list as uncertain for the missing slot", () =>
    Effect.gen(function* () {
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer(respond(201, { messageIds: ["brevo_one"] }))
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

  it.effect("retrieves and cancels through the email service", () =>
    Effect.gen(function* () {
      const methods: Array<string> = []
      const transport = yield* Brevo.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            methods.push(request.method)
            if (request.method === "POST") {
              return respond(201, { messageId: "brevo_1" })(request)
            }
            if (request.method === "DELETE") {
              return respond(200, {})(request)
            }
            return respond(200, {
              status: "processed",
              createdAt: "2026-01-01T00:00:00.000Z"
            })(request)
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
      yield* Email.cancel(receipt).pipe(Effect.provide(layer))

      assert.strictEqual(status.provider, "brevo")
      assert.strictEqual(status.state, "sent")
      assert.deepStrictEqual(methods, ["POST", "GET", "DELETE"])
    }))
})

