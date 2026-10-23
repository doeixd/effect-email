import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Email from "../src/Email"
import {
  DeliveryUncertain,
  ProviderRejected,
  TransportUnavailable,
  certaintyOf,
  isRetryable
} from "../src/EmailError"
import { destinationId, deliveryId, makeDestination, routeName } from "../src/Ids"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const baseMessage = {
  to: "customer@example.com",
  subject: "Your receipt",
  text: "Receipt body"
} as const

const makeEmail = (
  recorder: RecordingTransport.RecordingTransportShape,
  options: Partial<Email.EmailOptions> = {}
) =>
  Email.layer({
    defaultFrom: "billing@example.com",
    ...options,
    routes: options.routes ?? { default: recorder.transport }
  })

describe("Email.layerValidated", () => {
  it.effect("returns typed configuration errors", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const empty = yield* Effect.result(
        Email.layerValidated({
          defaultFrom: "billing@example.com",
          routes: {}
        })
      )
      const unknown = yield* Effect.result(
        Email.layerValidated({
          defaultFrom: "billing@example.com",
          defaultRoute: routeName("missing"),
          routes: { default: recorder.transport }
        })
      )

      assert.strictEqual(
        empty._tag === "Failure" && empty.failure._tag,
        "ConfigurationError"
      )
      assert.strictEqual(
        unknown._tag === "Failure" && unknown.failure._tag,
        "ConfigurationError"
      )
    }))
})
describe("Email", () => {
  it.effect("redacts sensitive transport error causes", () =>
    Effect.sync(() => {
      const cause = Object.assign(new Error("connection failed"), {
        request: {
          headers: { authorization: "Bearer super-secret" }
        }
      })
      const error = new TransportUnavailable({
        message: "transport failed",
        provider: "test",
        cause
      })

      assert.deepStrictEqual(error.cause, {
        name: "Error",
        message: "connection failed"
      })
      assert.notInclude(JSON.stringify(error), "super-secret")
    }))

  it.effect("derives collision-resistant destination ids", () =>
    Effect.sync(() => {
      assert.notStrictEqual(
        destinationId({ provider: "a:b", account: "c" }),
        destinationId({ provider: "a", account: "b:c" })
      )
    }))

  it.effect("sends through the recording transport", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const receipt = yield* Email.send(baseMessage).pipe(
        Effect.provide(makeEmail(recorder))
      )

      assert.strictEqual(receipt.provider, "recording")
      assert.strictEqual(receipt.destinationId, destinationId(makeDestination
        ({ provider: "recording", account: "default" })))
      assert.strictEqual(receipt.route, "default")
      assert.isString(receipt.deliveryId)
      assert.isTrue(receipt.deliveryId?.startsWith("dlv_"))

      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 1)
      assert.strictEqual(
        attempts[0]?.envelope.message.from.address,
        "billing@example.com"
      )
      assert.strictEqual(
        attempts[0]?.envelope.message.to[0]?.address,
        "customer@example.com"
      )
    }))

  it.effect("uses a per-message sender override", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      yield* Email.send({
        ...baseMessage,
        from: "support@example.com"
      }).pipe(Effect.provide(makeEmail(recorder)))

      const attempts = yield* recorder.attempts
      assert.strictEqual(
        attempts[0]?.envelope.message.from.address,
        "support@example.com"
      )
    }))

  it.effect("surfaces a scripted rejection without retrying", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          {
            type: "rejected",
            error: new ProviderRejected({
              message: "mailbox does not exist",
              provider: "recording",
              status: 422
            })
          }
        ]
      })

      const error = yield* Email.send(baseMessage).pipe(
        Effect.provide(makeEmail(recorder)),
        Effect.flip
      )

      assert.strictEqual(error._tag, "ProviderRejected")
      assert.strictEqual(certaintyOf(error), "rejected")
      assert.isFalse(isRetryable(error))

      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 1)
      assert.strictEqual(attempts[0]?.outcome, "failed")
    }))

  it.effect("surfaces scripted uncertainty distinctly", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [{ type: "uncertain" }]
      })

      const error = yield* Email.send(baseMessage).pipe(
        Effect.provide(makeEmail(recorder)),
        Effect.flip
      )

      assert.strictEqual(error._tag, "DeliveryUncertain")
      assert.strictEqual(certaintyOf(error), "unknown")
    }))

  it.effect("rejects unknown routes", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const error = yield* Email.send(baseMessage, {
        route: routeName("missing")
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      assert.strictEqual(error._tag, "UnsupportedCapability")
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 0)
    }))

  it.effect("refuses raw MIME unless the transport supports it", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const error = yield* Email.send({
        to: "customer@example.com",
        subject: "Raw",
        rawMime: new Uint8Array([1, 2, 3])
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      assert.strictEqual(error._tag, "UnsupportedCapability")
      if (error._tag === "UnsupportedCapability") {
        assert.strictEqual(error.capability, "raw-mime")
      }
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 0)
    }))

  it.effect("refuses remote attachments without the capability", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const error = yield* Email.send({
        ...baseMessage,
        attachments: [
          {
            filename: "invoice.pdf",
            source: { _tag: "url", url: "https://example.com/invoice.pdf" }
          }
        ]
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      assert.strictEqual(error._tag, "UnsupportedCapability")
      if (error._tag === "UnsupportedCapability") {
        assert.strictEqual(error.capability, "remote-attachments")
      }
    }))

  it.effect("enforces recipient limits", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        capabilities: { maxRecipientsPerMessage: 1 }
      })

      const error = yield* Email.send({
        ...baseMessage,
        to: ["one@example.com", "two@example.com"]
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      assert.strictEqual(error._tag, "UnsupportedCapability")
      if (error._tag === "UnsupportedCapability") {
        assert.strictEqual(error.capability, "max-recipients")
      }
    }))

  it.effect("classifies sender validation failures as not submitted", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const error = yield* Email.send({
        ...baseMessage,
        to: "broken-address"
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      assert.strictEqual(error._tag, "InvalidMessage")
      assert.strictEqual(certaintyOf(error), "not-submitted")
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 0)
    }))

  it.effect("keeps delivery ids stable when supplied", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const receipt = yield* Email.send(baseMessage, {
        deliveryId: deliveryId("delivery-id-1")
      }).pipe(Effect.provide(makeEmail(recorder)))

      assert.strictEqual(receipt.deliveryId, "delivery-id-1")
    }))

  it.effect("reuses scripted outcomes in order", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          { type: "rejected", error: new DeliveryUncertain({ message: "x" }) },
          { type: "accepted" }
        ]
      })
      const emailLayer = makeEmail(recorder)

      const first = yield* Email.send(baseMessage).pipe(
        Effect.provide(emailLayer),
        Effect.flip
      )
      assert.strictEqual(first._tag, "DeliveryUncertain")

      const second = yield* Email.send(baseMessage).pipe(
        Effect.provide(emailLayer)
      )
      assert.strictEqual(second.provider, "recording")
    }))

  it.effect("records nothing when preparation fails", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      yield* Email.send({
        to: [],
        subject: "Hi",
        text: "Body"
      }).pipe(Effect.provide(makeEmail(recorder)), Effect.flip)

      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 0)
    }))
})
