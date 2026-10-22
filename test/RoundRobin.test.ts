import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Email from "../src/Email"
import { TransportUnavailable, UnsupportedCapability } from "../src/EmailError"
import * as EmailTransport from "../src/EmailTransport"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const message = {
  to: "customer@example.com",
  subject: "Round robin",
  text: "Body"
} as const

const layerFor = (transport: EmailTransport.Transport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

const unavailable = () =>
  new TransportUnavailable({
    message: "temporary outage",
    provider: "recording",
    retryable: true
  })

describe("EmailTransport.withRoundRobin", () => {
  it.effect("selects each transport in turn for new sends", () =>
    Effect.gen(function* () {
      const first = yield* RecordingTransport.make({
        destination: { provider: "one", account: "primary" }
      })
      const second = yield* RecordingTransport.make({
        destination: { provider: "two", account: "primary" }
      })
      const transport = EmailTransport.withRoundRobin([
        first.transport,
        second.transport
      ])

      yield* Email.send(message).pipe(Effect.provide(layerFor(transport)))
      yield* Email.send(message).pipe(Effect.provide(layerFor(transport)))
      yield* Email.send(message).pipe(Effect.provide(layerFor(transport)))

      assert.strictEqual((yield* first.attempts).length, 2)
      assert.strictEqual((yield* second.attempts).length, 1)
    }))

  it.live("keeps a retry on the transport first selected", () =>
    Effect.gen(function* () {
      const first = yield* RecordingTransport.make({
        destination: { provider: "one", account: "primary" },
        script: [
          { type: "rejected", error: unavailable() },
          { type: "accepted", providerMessageId: "first_retry" }
        ]
      })
      const second = yield* RecordingTransport.make({
        destination: { provider: "two", account: "primary" }
      })
      const transport = EmailTransport.withRetry({
        maxAttempts: 2,
        baseDelayMillis: 1
      })(
        EmailTransport.withRoundRobin([first.transport, second.transport])
      )

      yield* Email.send(message).pipe(Effect.provide(layerFor(transport)))

      assert.strictEqual((yield* first.attempts).length, 2)
      assert.strictEqual((yield* second.attempts).length, 0)
    }))

  it.effect("advertises only capabilities every transport supports", () =>
    Effect.gen(function* () {
      const supporting = yield* RecordingTransport.make({
        destination: { provider: "one", account: "primary" },
        capabilities: { tags: true }
      })
      const refusing = yield* RecordingTransport.make({
        destination: { provider: "two", account: "primary" }
      })
      const transport = EmailTransport.withRoundRobin([
        supporting.transport,
        refusing.transport
      ])

      const result = yield* Effect.result(
        Email.send({ ...message, tags: ["receipt"] }).pipe(
          Effect.provide(layerFor(transport))
        )
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "UnsupportedCapability"
      )
      assert.strictEqual(
        result._tag === "Failure" &&
          result.failure._tag === "UnsupportedCapability" &&
          (result.failure as UnsupportedCapability).capability,
        "tags"
      )
    }))
})
