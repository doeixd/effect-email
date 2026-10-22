import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import * as EmailTransport from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"
import * as Resend from "../src/providers/Resend"

describe("Provider layers", () => {
  it.effect("shares one client instance with the generic transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const layer = Resend.layerWithClient({
          apiKey: Redacted.make("re_test_key")
        }).pipe(Layer.provide(FetchHttpClient.layer))
        const context = yield* Layer.build(layer)
        const client = Context.get(context, Resend.Client)
        const transport = Context.get(
          context,
          EmailTransport.EmailTransport
        )

        assert.strictEqual(client.transport, transport)
      })
    ))

  it.effect("shares the Mock client with its transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const layer = Mock.layerWithClient()
        const context = yield* Layer.build(layer)
        const client = Context.get(context, Mock.Client)
        const transport = Context.get(
          context,
          EmailTransport.EmailTransport
        )

        assert.strictEqual(client.transport, transport)
      })
    ))
})
