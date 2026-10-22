import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Mock from "../src/providers/Mock"
import { createEmail } from "../src/compat/CreateEmail"

describe("createEmail compatibility facade", () => {
  it.effect("sends single messages and batches", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const email = createEmail({
        transport: client.transport,
        defaultFrom: "billing@example.com"
      })

      const single = yield* Effect.promise(() =>
        email.send({
          to: "one@example.com",
          subject: "One",
          text: "Body"
        })
      )
      const batch = yield* Effect.promise(() =>
        email.sendBatch([
          { to: "two@example.com", subject: "Two", text: "Body" },
          { to: "three@example.com", subject: "Three", text: "Body" }
        ])
      )

      assert.strictEqual(single.data?.provider, "mock")
      assert.isUndefined(single.error)
      assert.deepStrictEqual(
        batch.results.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.strictEqual((yield* client.inbox.messages).length, 3)
    }))

  it.effect("streams chunked messages as promise results", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const email = createEmail({
        transport: client.transport,
        defaultFrom: "billing@example.com"
      })

      const results = yield* Effect.promise(async () => {
        const collected = []
        for await (const result of email.sendStream(
          [
            { to: "one@example.com", subject: "One", text: "Body" },
            { to: "two@example.com", subject: "Two", text: "Body" },
            { to: "three@example.com", subject: "Three", text: "Body" }
          ],
          { chunkSize: 2 }
        )) {
          collected.push(result)
        }
        return collected
      })

      assert.strictEqual(results.length, 3)
      assert.isTrue(results.every((result) => result.data !== undefined))
    }))
})
