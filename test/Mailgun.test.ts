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
import * as Mailgun from "../src/providers/Mailgun"

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

const formOf = (request: HttpClientRequest.HttpClientRequest): FormData | undefined =>
  request.body._tag === "FormData" ? request.body.formData : undefined

const emailLayerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

const options = {
  apiKey: Redacted.make("key-test"),
  domain: "mg.example.com"
} as const

describe("Mailgun", () => {
  it.effect("posts a multipart form with basic auth", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Mailgun.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            const form = formOf(request)!
            captured = {
              url: request.url,
              authorization: (() => {
                const value = Headers.get(request.headers, "authorization")
                return value._tag === "Some" ? value.value : undefined
              })(),
              from: form.get("from"),
              to: form.getAll("to"),
              cc: form.getAll("cc"),
              replyTo: form.get("h:Reply-To"),
              tag: form.getAll("o:tag"),
              subject: form.get("subject"),
              text: form.get("text"),
              html: form.get("html")
            }
            return respond(200, { id: "<mg_1@example.com>" })(request)
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
        tags: ["receipt"]
      }).pipe(Effect.provide(emailLayerFor(transport)))

      assert.isTrue(captured.url.endsWith("/v3/mg.example.com/messages"))
      assert.strictEqual(
        captured.authorization,
        `Basic ${Buffer.from("api:key-test").toString("base64")}`
      )
      assert.strictEqual(captured.from, "billing@example.com")
      assert.deepStrictEqual(captured.to, ["customer@example.com"])
      assert.deepStrictEqual(captured.cc, ["cc@example.com"])
      assert.strictEqual(captured.replyTo, "support@example.com")
      assert.deepStrictEqual(captured.tag, ["receipt"])
      assert.strictEqual(captured.subject, "Your receipt")
      assert.strictEqual(captured.text, "Receipt body")
      assert.strictEqual(captured.html, "<p>Receipt body</p>")
      assert.strictEqual(receipt.provider, "mailgun")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("mg_1@example.com")
      )
    }))

  it.effect("merges compatible recipients into one batch request", () =>
    Effect.gen(function* () {
      const requests: Array<{ to: Array<string>; variables: string | null }> = []
      const transport = yield* Mailgun.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            const form = formOf(request)!
            requests.push({
              to: form.getAll("to") as Array<string>,
              variables: form.get("recipient-variables") as string | null
            })
            return respond(200, { id: "<mg_batch@example.com>" })(request)
          })
        )
      )

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "Hi", text: "Body" },
        { to: "two@example.com", subject: "Hi", text: "Body" }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 1)
      assert.deepStrictEqual(requests[0]!.to, [
        "one@example.com",
        "two@example.com"
      ])
      const variables = JSON.parse(requests[0]!.variables!)
      assert.deepStrictEqual(Object.keys(variables).sort(), [
        "one@example.com",
        "two@example.com"
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
          providerMessageId("mg_batch@example.com"),
          providerMessageId("mg_batch@example.com")
        ]
      )
    }))

  it.effect("sends messages with attachments one at a time", () =>
    Effect.gen(function* () {
      const requests: Array<{ to: Array<string>; attachments: number }> = []
      const transport = yield* Mailgun.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            const form = formOf(request)!
            requests.push({
              to: form.getAll("to") as Array<string>,
              attachments: form.getAll("attachment").length
            })
            return respond(200, { id: "<mg_solo@example.com>" })(request)
          })
        )
      )

      yield* Email.sendBatch([
        {
          to: "one@example.com",
          subject: "Hi",
          text: "Body",
          attachments: [
            {
              filename: "receipt.txt",
              source: { _tag: "content", content: new Uint8Array([1, 2, 3]) }
            }
          ]
        },
        {
          to: "two@example.com",
          subject: "Hi",
          text: "Body",
          attachments: [
            {
              filename: "receipt.txt",
              source: { _tag: "content", content: new Uint8Array([1, 2, 3]) }
            }
          ]
        }
      ]).pipe(Effect.provide(emailLayerFor(transport)))

      assert.strictEqual(requests.length, 2)
      assert.deepStrictEqual(requests[0]!.to, ["one@example.com"])
      assert.strictEqual(requests[0]!.attachments, 1)
    }))
})

