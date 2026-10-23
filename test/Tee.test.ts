import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Email from "../src/Email"
import * as EmailTransport from "../src/EmailTransport"
import { deliveryId, destinationId, routeName } from "../src/Ids"
import { prepare } from "../src/Message"
import type { PreparedEnvelope } from "../src/Submission"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const envelopeFor = (transport: EmailTransport.Transport) =>
  Effect.gen(function* () {
    const message = yield* prepare(
      {
        from: "sender@example.com",
        to: "user@example.com",
        subject: "Tee",
        text: "Body"
      },
      {
        from: "sender@example.com",
        deliveryId: deliveryId("dlv_tee_1")
      }
    )
    return {
      message,
      deliveryId: message.deliveryId!,
      route: routeName("default"),
      destination: transport.destination,
      destinationId: destinationId(transport.destination)
    }
  })

describe("EmailTransport.withTee", () => {
  it.effect("returns both receipts from the explicit tee operation", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" }
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" }
      })
      const transport = EmailTransport.withTee(primary.transport, [
        secondary.transport
      ])

      const outcome = yield* transport.tee(
        yield* envelopeFor(primary.transport)
      )

      assert.strictEqual(outcome.primary.provider, "primary")
      assert.strictEqual(outcome.mirrors.length, 1)
      assert.strictEqual(
        outcome.mirrors[0]?.receipt?.provider,
        "secondary"
      )
      assert.strictEqual((yield* primary.attempts).length, 1)
      assert.strictEqual((yield* secondary.attempts).length, 1)
    }))

  it.effect("does not fail the primary when a mirror rejects", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" }
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" },
        script: [{ type: "rejected" }]
      })
      const failures: Array<number> = []
      const transport = EmailTransport.withTee(
        primary.transport,
        [secondary.transport],
        {
          onSecondaryError: (failure) => {
            failures.push(failure.index)
          }
        }
      )

      const outcome = yield* transport.tee(
        yield* envelopeFor(primary.transport)
      )

      assert.strictEqual(outcome.primary.provider, "primary")
      assert.isDefined(outcome.mirrors[0]?.error)
      assert.deepStrictEqual(failures, [0])
    }))

  it.effect("redirects mirror recipients to a sink", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" }
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" }
      })
      const transport = EmailTransport.withTee(
        primary.transport,
        [secondary.transport],
        { mirrorTo: "sink@example.com" }
      )

      yield* Email.send({
        to: "user@example.com",
        subject: "Tee",
        text: "Body"
      }, { rawEnvelope: { mailFrom: null, rcptTo: ["user@example.com"] } }).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "sender@example.com",
            routes: { default: transport }
          })
        )
      )

      const mirrored = yield* secondary.attempts
      assert.strictEqual(mirrored.length, 1)
      assert.strictEqual(
        mirrored[0]?.envelope.message.to[0]?.address,
        "sink@example.com"
      )
      assert.deepStrictEqual(mirrored[0]?.envelope.rawEnvelope, {
        mailFrom: null, rcptTo: ["sink@example.com"]
      })
      const delivered = yield* primary.attempts
      assert.strictEqual(
        delivered[0]?.envelope.message.to[0]?.address,
        "user@example.com"
      )
      assert.deepStrictEqual(delivered[0]?.envelope.rawEnvelope?.rcptTo, ["user@example.com"])
    }))
})
