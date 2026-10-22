import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Email from "../src/Email"
import type { Transport } from "../src/EmailTransport"
import { providerMessageId } from "../src/Ids"
import * as Azure from "../src/providers/AzureCommunication"

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
  endpoint: "https://azure.test",
  accessKey: Buffer.from("secret-key").toString("base64"),
  now: new Date("2026-01-01T00:00:00.000Z")
} as const

const layerFor = (transport: Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("Azure Communication", () => {
  it.effect("signs and sends a structured request", () =>
    Effect.gen(function* () {
      let captured: any
      const transport = yield* Azure.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            captured = {
              url: request.url,
              method: request.method,
              authorization: headerValue(
                request.headers,
                "authorization"
              ),
              date: headerValue(request.headers, "x-ms-date"),
              hash: headerValue(
                request.headers,
                "x-ms-content-sha256"
              ),
              body: bodyOf(request)
            }
            return respond(
              202,
              { id: "op_1" },
              {
                "operation-location":
                  "https://azure.test/emails/operations/op_1?api-version=2025-09-01",
                "x-ms-request-id": "req_1"
              }
            )(request)
          })
        )
      )

      const receipt = yield* Email.send({
        to: "user@example.com",
        cc: "cc@example.com",
        subject: "Azure subject",
        text: "Azure body"
      }).pipe(Effect.provide(layerFor(transport)))

      assert.include(captured.url, "/emails:send?api-version=")
      assert.strictEqual(captured.method, "POST")
      assert.match(
        captured.authorization,
        /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/
      )
      assert.strictEqual(
        captured.date,
        "Thu, 01 Jan 2026 00:00:00 GMT"
      )
      assert.match(captured.hash, /^[A-Za-z0-9+/]+=*$/)
      assert.strictEqual(
        captured.body.senderAddress,
        "billing@example.com"
      )
      assert.deepStrictEqual(captured.body.recipients.to, [
        { address: "user@example.com" }
      ])
      assert.strictEqual(captured.body.content.subject, "Azure subject")
      assert.strictEqual(captured.body.content.plainText, "Azure body")
      assert.strictEqual(receipt.provider, "azure-communication")
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("op_1")
      )
      assert.strictEqual(receipt.requestId, "req_1")
    }))

  it.effect("retrieves operation status by receipt", () =>
    Effect.gen(function* () {
      const transport = yield* Azure.make(options).pipe(
        Effect.provide(
          clientLayer((request) => {
            if (request.method === "GET") {
              return respond(200, {
                id: "op_1",
                status: "Succeeded"
              })(request)
            }
            return respond(
              202,
              { id: "op_1" },
              {
                "operation-location":
                  "https://azure.test/emails/operations/op_1"
              }
            )(request)
          })
        )
      )
      const layer = layerFor(transport)
      const receipt = yield* Email.send({
        to: "user@example.com",
        subject: "Azure subject",
        text: "Azure body"
      }).pipe(Effect.provide(layer))

      const status = yield* Email.retrieve(receipt).pipe(
        Effect.provide(layer)
      )

      assert.strictEqual(status.provider, "azure-communication")
      assert.strictEqual(status.state, "sent")
    }))
})
