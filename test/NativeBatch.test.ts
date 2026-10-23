import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import * as Email from "../src/Email"
import { ProviderRejected, DeliveryUncertain } from "../src/EmailError"
import { destinationId, makeDestination } from "../src/Ids"
import type { NativeBatchTransport } from "../src/EmailTransport"
import { makeCapabilities } from "../src/EmailTransport"
import type {
  MessageOutcome,
  PreparedEnvelope
} from "../src/Submission"
import { makeReceipt } from "../src/Submission"

const message = (to: string) => ({
  to,
  subject: "Native batch",
  text: "Body"
})

const accepted = (
  envelope: PreparedEnvelope,
  transport: NativeBatchTransport
): MessageOutcome => ({
  _tag: "accepted",
  index: 0,
  receipt: makeReceipt({
    provider: envelope.destination.provider,
    destinationId: destinationId(transport.destination),
    deliveryId: envelope.deliveryId,
    acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    route: envelope.route
  })
})

const nativeTransport = (
  maxBatchSize: number,
  respond?: (
    envelopes: ReadonlyArray<PreparedEnvelope>,
    transport: NativeBatchTransport
  ) => ReadonlyArray<MessageOutcome>
): {
  readonly transport: NativeBatchTransport
  readonly calls: Array<ReadonlyArray<PreparedEnvelope>>
} => {
  const calls: Array<ReadonlyArray<PreparedEnvelope>> = []
  const transport = {
    destination: makeDestination({ provider: "native", account: "test" }),
    capabilities: makeCapabilities({
      nativeBatch: true,
      maxBatchSize
    }),
    send: () => Effect.die("single send must not be used for native batches"),
    sendBatch: (envelopes: ReadonlyArray<PreparedEnvelope>) => {
      calls.push(envelopes)
      return Effect.succeed(
        respond === undefined
          ? envelopes.map((envelope, index) => ({
              ...accepted(envelope, transport),
              index
            }))
          : respond(envelopes, transport)
      )
    }
  } as unknown as NativeBatchTransport
  return { transport, calls }
}

const layerFor = (transport: NativeBatchTransport) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

describe("Email.sendBatch native dispatch", () => {
  it.effect("reconciles provider positions back to input indices", () =>
    Effect.gen(function* () {
      const { transport, calls } = nativeTransport(10, (envelopes, self) => [
        { ...accepted(envelopes[0]!, self), index: 0 },
        {
          _tag: "rejected",
          index: 1,
          error: ProviderRejected.new({
            message: "mailbox rejected",
            provider: "native"
          })
        }
      ])

      const outcomes = yield* Email.sendBatch([
        message("one@example.com"),
        message("not-an-email"),
        message("two@example.com"),
        message("three@example.com")
      ]).pipe(Effect.provide(layerFor(transport)))

      assert.deepStrictEqual(
        outcomes.map((outcome) => [outcome._tag, outcome.index]),
        [
          ["accepted", 0],
          ["invalid", 1],
          ["rejected", 2],
          ["uncertain", 3]
        ]
      )
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0]?.length, 3)

      const uncertain = outcomes[3]!
      assert.strictEqual(
        uncertain._tag === "uncertain" && uncertain.error._tag,
        "DeliveryUncertain"
      )
    }))

  it.effect("fills delivery metadata on native batch receipts", () =>
    Effect.gen(function* () {
      const { transport } = nativeTransport(10, (envelopes, self) => [
        {
          _tag: "accepted",
          index: 0,
          receipt: makeReceipt({
            provider: self.destination.provider,
            destinationId: destinationId(self.destination),
            acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z")
          })
        }
      ])

      const outcomes = yield* Email.sendBatch([
        message("one@example.com")
      ]).pipe(Effect.provide(layerFor(transport)))

      const accepted = outcomes[0]!
      assert.isTrue(
        accepted._tag === "accepted" &&
          accepted.receipt.deliveryId !== undefined &&
          accepted.receipt.deliveryId.startsWith("dlv_")
      )
      assert.isTrue(
        accepted._tag === "accepted" &&
          accepted.receipt.route === "default"
      )
    }))

  it.effect("chunks envelopes by the provider batch limit", () =>
    Effect.gen(function* () {
      const { transport, calls } = nativeTransport(2)

      const outcomes = yield* Email.sendBatch([
        message("one@example.com"),
        message("two@example.com"),
        message("three@example.com"),
        message("four@example.com"),
        message("five@example.com")
      ], { concurrency: 1 }).pipe(Effect.provide(layerFor(transport)))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted", "accepted", "accepted", "accepted"]
      )
      assert.deepStrictEqual(
        calls.map((call) => call.length),
        [2, 2, 1]
      )
    }))

  it.effect("marks every envelope uncertain when the batch call is ambiguous", () =>
    Effect.gen(function* () {
      const { transport } = nativeTransport(10)
      const ambiguous: NativeBatchTransport = {
        ...transport,
        sendBatch: () =>
          Effect.fail(
            DeliveryUncertain.new({
              message: "connection dropped after batch write",
              provider: "native"
            })
          )
      }

      const outcomes = yield* Email.sendBatch([
        message("one@example.com"),
        message("two@example.com")
      ]).pipe(Effect.provide(layerFor(ambiguous)))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["uncertain", "uncertain"]
      )
    }))
})
