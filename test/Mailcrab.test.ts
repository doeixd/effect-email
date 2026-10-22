import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import * as Mailcrab from "../src/providers/Mailcrab"

const respond = (body: unknown) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: 200,
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

describe("Mailcrab", () => {
  it.effect("lists, finds, and deletes captured messages", () =>
    Effect.gen(function* () {
      const summaries = [
        {
          id: "one",
          subject: "First",
          time: 1,
          to: [{ email: "user@example.com" }],
          envelope_recipients: ["user@example.com"]
        },
        {
          id: "two",
          subject: "Second",
          time: 2,
          to: [{ email: "other@example.com" }],
          envelope_recipients: ["other@example.com"]
        }
      ]
      const calls: Array<string> = []
      const client = yield* Mailcrab.makeClient({
        httpEndpoint: "http://mailcrab.test"
      }).pipe(
        Effect.provide(
          clientLayer((request) => {
            calls.push(`${request.method} ${request.url}`)
            if (request.url.includes("/raw")) {
              return textResponse("raw mailcrab")(request)
            }
            if (request.url.includes("/attachment/")) {
              return bytesResponse(new Uint8Array([4, 5]))(request)
            }
            if (request.url.includes("/api/message/two")) {
              return respond({ id: "two", subject: "Second" })(request)
            }
            if (
              request.url.includes("/api/delete/") ||
              request.url.includes("/api/delete-all")
            ) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, { status: 200 })
                )
              )
            }
            return respond(summaries)(request)
          })
        )
      )

      const listed = yield* client.inbox.list
      const found = yield* client.inbox.find("user@example.com")
      const last = yield* client.inbox.last
      const raw = yield* client.inbox.raw("two")
      const attachment = yield* client.inbox.attachment("two", 0)
      yield* client.inbox.delete("one")
      yield* client.inbox.clear

      assert.strictEqual(listed.length, 2)
      assert.strictEqual(
        (listed[0] as { id: string }).id,
        "two"
      )
      assert.strictEqual(found.length, 1)
      assert.strictEqual(
        (last as { id?: string }).id,
        "two"
      )
      assert.strictEqual(raw, "raw mailcrab")
      assert.deepStrictEqual([...attachment], [4, 5])
      assert.isTrue(calls.some((call) => call.includes("/api/delete/one")))
      assert.isTrue(calls.some((call) => call.includes("/api/delete-all")))
    }))
})
