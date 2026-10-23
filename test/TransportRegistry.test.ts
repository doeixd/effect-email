import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Email from "../src/Email"
import { UnsupportedCapability } from "../src/EmailError"
import { routeName } from "../src/Ids"
import * as RecordingTransport from "../src/testing/RecordingTransport"
import * as TransportRegistry from "../src/TransportRegistry"

describe("TransportRegistry", () => {
  it.effect("resolves routes and reports unknown routes", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" }
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" }
      })
      const registry = yield* TransportRegistry.make({
        default: primary.transport,
        bulk: secondary.transport
      })

      const found = yield* registry.get(routeName("bulk"))
      const missing = yield* Effect.result(
        registry.get(routeName("missing"))
      )

      assert.strictEqual(found.destination.provider, "secondary")
      assert.strictEqual(registry.defaultRoute, "default")
      assert.strictEqual(
        missing._tag === "Failure" && missing.failure._tag,
        "UnsupportedCapability"
      )
    }))

  it.effect("returns typed configuration errors", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.result(
        TransportRegistry.makeValidated({})
      )
      assert.strictEqual(
        empty._tag === "Failure" && empty.failure._tag,
        "ConfigurationError"
      )
    }))
  it.effect("sends through the selected registry route", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" }
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" }
      })
      const registry = yield* TransportRegistry.make({
        default: primary.transport,
        bulk: secondary.transport
      })
      const layer = Email.layerFromRegistry({
        defaultFrom: "billing@example.com",
        registry
      })

      yield* Email.send({
        to: "one@example.com",
        subject: "Default",
        text: "Body"
      }).pipe(Effect.provide(layer))
      yield* Email.send(
        {
          to: "two@example.com",
          subject: "Bulk",
          text: "Body"
        },
        { route: routeName("bulk") }
      ).pipe(Effect.provide(layer))

      assert.strictEqual((yield* primary.attempts).length, 1)
      assert.strictEqual((yield* secondary.attempts).length, 1)
    }))

  it.effect("builds Email from a registry layer", () =>
    Effect.gen(function* () {
      const transport = yield* RecordingTransport.make()
      const registryLayer = TransportRegistry.layer({
        default: transport.transport
      })
      const emailLayer = Email.layerFromRegistryLayer({
        defaultFrom: "billing@example.com",
        registry: registryLayer
      })

      yield* Email.send({
        to: "one@example.com",
        subject: "Layer registry",
        text: "Body"
      }).pipe(Effect.provide(emailLayer))

      assert.strictEqual((yield* transport.attempts).length, 1)
    }))

  it.effect("provides the registry as a layer service", () =>
    Effect.gen(function* () {
      const transport = yield* RecordingTransport.make()
      const layer = TransportRegistry.layer({
        default: transport.transport
      })
      const names = yield* TransportRegistry.routes.pipe(
        Effect.provide(layer)
      )
      const selected = yield* TransportRegistry.get(
        routeName("default")
      ).pipe(Effect.provide(layer))

      assert.deepStrictEqual(names, [routeName("default")])
      assert.strictEqual(
        selected.destination.provider,
        "recording"
      )
    }))
})
