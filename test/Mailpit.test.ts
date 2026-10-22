import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Mailpit from "../src/providers/Mailpit"

const summary = (id: string, to: string, subject: string) => ({
  ID: id,
  MessageID: id,
  Subject: subject,
  To: [{ Name: "", Address: to }],
  Cc: [],
  Bcc: []
})

const respond = (body: unknown, status = 200) =>
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

const textResponse = (body: string) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" }
        })
      )
    )

const bytesResponse = (body: Uint8Array) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body.buffer as ArrayBuffer, { status: 200 })
      )
    )

const clientLayer = (
  handler: Parameters<typeof HttpClient.make>[0]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler))

describe("Mailpit", () => {
  it.effect("queries the inbox and deletes messages", () =>
    Effect.gen(function* () {
      const messages = [
        summary("one", "user@example.com", "First"),
        summary("two", "other@example.com", "Second")
      ]
      const deleted: Array<unknown> = []
      const client = yield* Mailpit.makeClient({
        httpEndpoint: "http://mailpit.test"
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            if (request.method === "DELETE") {
              deleted.push(request.body)
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, { status: 200 })
                )
              )
            }
            if (request.url.includes("/raw")) {
              return textResponse("raw message")(request)
            }
            if (request.url.includes("/part/")) {
              return bytesResponse(new Uint8Array([1, 2, 3]))(request)
            }
            if (request.url.endsWith("/api/v1/message/latest")) {
              return respond(messages[1])(request)
            }
            if (request.url.includes("/api/v1/search")) {
              return respond({ messages })(request)
            }
            return respond({ messages })(request)
          })
        )
      )

      const listed = yield* client.inbox.list
      const found = yield* client.inbox.find("user@example.com")
      const last = yield* client.inbox.last
      const raw = yield* client.inbox.raw("one")
      const attachment = yield* client.inbox.attachment("one", "1")
      yield* client.inbox.delete("one")
      yield* client.inbox.clear

      assert.strictEqual(listed.length, 2)
      assert.strictEqual(found.length, 1)
      assert.strictEqual(
        (found[0] as { ID: string }).ID,
        "one"
      )
      assert.strictEqual(
        (last as { subject?: string; Subject?: string }).Subject,
        "Second"
      )
      assert.strictEqual(raw, "raw message")
      assert.deepStrictEqual([...attachment], [1, 2, 3])
      assert.strictEqual(deleted.length, 2)
    }))
})
