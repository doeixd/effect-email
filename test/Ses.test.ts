import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import type { Transport } from "../src/EmailTransport"
import { providerMessageId } from "../src/Ids"
import * as Ses from "../src/providers/Ses"

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
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
  if (body._tag !== "Uint8Array") return undefined
  return JSON.parse(new TextDecoder().decode(body.body))
}

const headerValue = (
  headers: Headers.Headers,
  name: string
): string | undefined => {
  const value = Headers.get(headers, name)
  return value._tag === "Some" ? value.value : undefined
}

const options = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: Redacted.make("secret"),
  region: "us-east-1",
  baseUrl: "https://email.test"
} as const

const layerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("SES", () => {
  it.effect("signs and sends a raw MIME request", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Ses.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              authorization: headerValue(
                request.headers,
                "authorization"
              ),
              date: headerValue(request.headers, "x-amz-date"),
              hash: headerValue(
                request.headers,
                "x-amz-content-sha256"
              ),
              body: bodyOf(request)
            }
            return respond(
              200,
              { MessageId: "ses_1" },
              { "x-amzn-requestid": "req_1" }
            )(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "user@example.com",
        subject: "SES subject",
        text: "SES body"
      }).pipe(Effect.provide(layerFor(transport)))

      assert.strictEqual(
        captured.url,
        "https://email.test/v2/email/outbound-emails"
      )
      assert.match(
        captured.authorization,
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//
      )
      assert.match(captured.date, /^\d{8}T\d{6}Z$/)
      assert.match(captured.hash, /^[0-9a-f]{64}$/)
      const raw = Buffer.from(
        captured.body.Content.Raw.Data,
        "base64"
      ).toString("utf8")
      assert.include(raw, "Subject: SES subject")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("ses_1")
      )
      assert.strictEqual(receipt.provider, "ses")
      assert.strictEqual(receipt.requestId, "req_1")
    }))

  it.effect("classifies SES throttling as retryable", () =>
    Effect.gen(function* () {
      const transport = yield* Ses.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              message: "Rate exceeded",
              __type: "ThrottlingException"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "user@example.com",
          subject: "SES subject",
          text: "SES body"
        }).pipe(Effect.provide(layerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "RateLimited"
      )
    }))

  it.effect("treats a server error as uncertain", () =>
    Effect.gen(function* () {
      const transport = yield* Ses.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(500, {
              message: "Internal failure",
              __type: "InternalFailure"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "user@example.com",
          subject: "SES subject",
          text: "SES body"
        }).pipe(Effect.provide(layerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "DeliveryUncertain"
      )
    }))

  it.effect("classifies a provider rejection", () =>
    Effect.gen(function* () {
      const transport = yield* Ses.make(options).pipe(
        Effect.provide(
          clientLayer(
            respond(400, {
              message: "Message rejected",
              __type: "MessageRejected"
            })
          )
        )
      )

      const result = yield* Effect.result(
        Email.send({
          to: "user@example.com",
          subject: "SES subject",
          text: "SES body"
        }).pipe(Effect.provide(layerFor(transport)))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "ProviderRejected"
      )
    }))
})
