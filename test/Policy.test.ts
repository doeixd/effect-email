import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as Email from "../src/Email"
import {
  DeliveryUncertain,
  TransportUnavailable,
  UnsupportedCapability
} from "../src/EmailError"
import * as EmailTransport from "../src/EmailTransport"
import { destinationId, makeDestination, providerMessageId } from "../src/Ids"
import { makeReceipt } from "../src/Submission"
import * as Mock from "../src/providers/Mock"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const message = {
  to: "customer@example.com",
  subject: "Policy",
  text: "Body"
} as const

const unavailable = () =>
  TransportUnavailable.new({
    message: "temporary outage",
    provider: "recording",
    retryable: true
  })

describe("EmailTransport.withRetry", () => {
  it.live("retries retryable failures and returns the later receipt", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          { type: "rejected", error: unavailable() },
          { type: "accepted", providerMessageId: "rec_2" }
        ]
      })
      const transport = EmailTransport.withRetry({
        maxAttempts: 3,
        baseDelayMillis: 1
      })(recorder.transport)
      const receipt = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.strictEqual(receipt.providerMessageId, providerMessageId("rec_2"))
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 2)
    }))

  it.live("stops after the configured attempt budget", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          { type: "rejected", error: unavailable() },
          { type: "rejected", error: unavailable() },
          { type: "accepted" }
        ]
      })
      const transport = EmailTransport.withRetry({
        maxAttempts: 2,
        baseDelayMillis: 1
      })(recorder.transport)
      const error = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        ),
        Effect.flip
      )

      assert.strictEqual(error._tag, "TransportUnavailable")
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 2)
    }))

  it.effect("never retries an uncertain submission", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          {
            type: "uncertain",
            error: DeliveryUncertain.new({
              message: "connection dropped after write",
              provider: "recording"
            })
          },
          { type: "accepted" }
        ]
      })
      const transport = EmailTransport.withRetry({
        maxAttempts: 3,
        baseDelayMillis: 1
      })(recorder.transport)
      const error = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        ),
        Effect.flip
      )

      assert.strictEqual(error._tag, "DeliveryUncertain")
      const attempts = yield* recorder.attempts
      assert.strictEqual(attempts.length, 1)
    }))

  it.effect("preserves destination and capabilities", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        destination: { provider: "fake", account: "policy" },
        capabilities: { tags: true }
      })
      const transport = EmailTransport.withRetry()(recorder.transport)

      assert.strictEqual(transport.destination, recorder.transport.destination)
      assert.strictEqual(
        transport.capabilities,
        recorder.transport.capabilities
      )
    }))
})

describe("EmailTransport.withRetry native batch", () => {
  it.live("preserves native batch dispatch and retries the batch", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const base = client.transport as EmailTransport.NativeBatchTransport
      let calls = 0
      const transport: EmailTransport.NativeBatchTransport = {
        ...base,
        sendBatch: (envelopes) =>
          Effect.suspend(() => {
            calls += 1
            if (calls === 1) {
              return Effect.fail(unavailable())
            }
            return base.sendBatch(envelopes)
          })
      }
      const retried = EmailTransport.withRetry({
        maxAttempts: 2,
        baseDelayMillis: 1
      })(transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: retried }
      })

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "One", text: "One" },
        { to: "two@example.com", subject: "Two", text: "Two" }
      ]).pipe(Effect.provide(layer))

      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.strictEqual((yield* client.inbox.messages).length, 2)
    }))

  it.live("retries only eligible native batch slots", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const base = client.transport as EmailTransport.NativeBatchTransport
      let calls = 0
      let retriedEnvelopes = 0
      const transport: EmailTransport.NativeBatchTransport = {
        ...base,
        capabilities: {
          ...base.capabilities,
          partialBatchRetry: true
        },
        sendBatch: (envelopes) =>
          Effect.suspend(() => {
            calls += 1
            if (calls === 1) {
              return Effect.gen(function* () {
                const first = yield* base.sendBatch([envelopes[0]!])
                return [
                  first[0]!,
                  {
                    _tag: "rejected" as const,
                    index: 1,
                    error: unavailable()
                  }
                ]
              })
            }
            retriedEnvelopes = envelopes.length
            return base.sendBatch(envelopes)
          })
      }
      const retried = EmailTransport.withRetry({
        maxAttempts: 3,
        baseDelayMillis: 1
      })(transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: retried }
      })

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "One", text: "One" },
        { to: "two@example.com", subject: "Two", text: "Two" }
      ]).pipe(Effect.provide(layer))

      assert.strictEqual(calls, 2)
      assert.strictEqual(retriedEnvelopes, 1)
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted"]
      )
      assert.strictEqual((yield* client.inbox.messages).length, 2)
    }))

  it.live("does not retry an uncertain native batch", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const base = client.transport as EmailTransport.NativeBatchTransport
      let calls = 0
      const transport: EmailTransport.NativeBatchTransport = {
        ...base,
        sendBatch: () =>
          Effect.suspend(() => {
            calls += 1
            return Effect.fail(
              DeliveryUncertain.new({
                message: "outcome unknown",
                provider: "recording"
              })
            )
          })
      }
      const retried = EmailTransport.withRetry({
        maxAttempts: 3,
        baseDelayMillis: 1
      })(transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: retried }
      })

      const outcomes = yield* Email.sendBatch([
        { to: "one@example.com", subject: "One", text: "One" }
      ]).pipe(Effect.provide(layer))

      assert.strictEqual(calls, 1)
      assert.strictEqual(outcomes[0]?._tag, "uncertain")
    }))
})

describe("EmailTransport.withFallback", () => {
  it.effect("sends through the secondary after a safe primary failure", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" },
        script: [{ type: "rejected" }]
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" }
      })
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      const receipt = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.strictEqual(receipt.provider, "secondary")
      assert.strictEqual((yield* primary.attempts).length, 1)
      assert.strictEqual((yield* secondary.attempts).length, 1)
    }))

  it.effect("does not fail over an uncertain submission", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        script: [{ type: "uncertain" }]
      })
      const secondary = yield* RecordingTransport.make()
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      const error = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        ),
        Effect.flip
      )

      assert.strictEqual(error._tag, "DeliveryUncertain")
      assert.strictEqual((yield* secondary.attempts).length, 0)
    }))

  it.effect("revalidates the fallback target before dispatch", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        capabilities: { tags: true },
        script: [{ type: "rejected" }]
      })
      const secondary = yield* RecordingTransport.make({
        capabilities: { tags: false }
      })
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      const error = yield* Email.send({
        to: "customer@example.com",
        subject: "Tags",
        text: "Body",
        tags: ["billing"]
      }).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        ),
        Effect.flip
      )

      assert.strictEqual(error._tag, "UnsupportedCapability")
      assert.strictEqual((yield* secondary.attempts).length, 0)
    }))

  it.effect("uses the smaller composite batch and recipient limits", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        capabilities: {
          maxBatchSize: 100,
          maxRecipientsPerMessage: 50
        }
      })
      const secondary = yield* RecordingTransport.make({
        capabilities: {
          maxBatchSize: 10,
          maxRecipientsPerMessage: 20
        }
      })
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      assert.strictEqual(transport.capabilities.maxBatchSize, 10)
      assert.strictEqual(
        transport.capabilities.maxRecipientsPerMessage,
        20
      )
    }))

  it.effect("does not fail over local capability failures", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        script: [
          {
            type: "rejected",
            error: UnsupportedCapability.new({
              message: "no tags",
              provider: "primary",
              capability: "tags"
            })
          }
        ]
      })
      const secondary = yield* RecordingTransport.make()
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      const error = yield* Email.send(message).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        ),
        Effect.flip
      )

      assert.strictEqual(error._tag, "UnsupportedCapability")
      assert.strictEqual((yield* secondary.attempts).length, 0)
    }))

  it.effect("advertises receipt-routed capabilities when either leg supports them", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        capabilities: { retrieve: true }
      })
      const secondary = yield* RecordingTransport.make()
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      assert.isTrue(transport.capabilities.retrieve)
      assert.isFalse(transport.capabilities.cancel)
    }))

  it.effect("fails over only the rejected batch slots", () =>
    Effect.gen(function* () {
      const primary = yield* RecordingTransport.make({
        destination: { provider: "primary" },
        script: [
          { type: "accepted", providerMessageId: "primary_1" },
          { type: "rejected" },
          { type: "uncertain" }
        ]
      })
      const secondary = yield* RecordingTransport.make({
        destination: { provider: "secondary" },
        script: [{ type: "accepted", providerMessageId: "secondary_2" }]
      })
      const transport = EmailTransport.withFallback(secondary.transport)(
        primary.transport
      )

      const outcomes = yield* Email.sendBatch([
        { ...message, to: "one@example.com" },
        { ...message, to: "two@example.com" },
        { ...message, to: "three@example.com" }
      ], { concurrency: 1 }).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "billing@example.com",
            routes: { default: transport }
          })
        )
      )

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "accepted", "uncertain"]
      )
      const second = outcomes[1]!
      assert.strictEqual(
        second._tag === "accepted" &&
          second.receipt.provider,
        "secondary"
      )
      assert.strictEqual((yield* secondary.attempts).length, 1)
    }))
})



describe("EmailTransport.withRateLimit", () => {
  it.effect("waits for a request token before the next send", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const transport = yield* EmailTransport.withRateLimit({
        requests: { limit: 1, intervalMillis: 100 }
      })(recorder.transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      yield* Email.send(message).pipe(Effect.provide(layer))
      const fiber = yield* Email.send(message).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* Effect.yieldNow

      assert.strictEqual((yield* recorder.attempts).length, 1)
      yield* TestClock.adjust(100)
      yield* Fiber.join(fiber)
      assert.strictEqual((yield* recorder.attempts).length, 2)
    }).pipe(Effect.provide(EmailTransport.layerRateLimiterMemory)))

  it.effect("rejects a message larger than the recipient window", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make()
      const transport = yield* EmailTransport.withRateLimit({
        recipients: { limit: 1, intervalMillis: 100 }
      })(recorder.transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const error = yield* Email.send({
        to: ["one@example.com", "two@example.com"],
        subject: "Too large",
        text: "Body"
      }).pipe(Effect.provide(layer), Effect.flip)

      assert.strictEqual(error._tag, "UnsupportedCapability")
      assert.strictEqual((yield* recorder.attempts).length, 0)
    }).pipe(Effect.provide(EmailTransport.layerRateLimiterMemory)))

  it.effect("charges a native batch by message and recipient", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const transport = yield* EmailTransport.withRateLimit({
        messages: { limit: 2, intervalMillis: 100 },
        recipients: { limit: 2, intervalMillis: 100 }
      })(client.transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      yield* Email.sendBatch([
        { to: "one@example.com", subject: "One", text: "One" },
        { to: "two@example.com", subject: "Two", text: "Two" }
      ]).pipe(Effect.provide(layer))
      const fiber = yield* Email.send({
        to: "three@example.com",
        subject: "Three",
        text: "Three"
      }).pipe(Effect.provide(layer), Effect.forkChild)
      yield* Effect.yieldNow

      assert.strictEqual((yield* client.inbox.messages).length, 2)
      yield* TestClock.adjust(100)
      yield* Fiber.join(fiber)
      assert.strictEqual((yield* client.inbox.messages).length, 3)
    }).pipe(Effect.provide(EmailTransport.layerRateLimiterMemory)))
})

describe("EmailTransport.withCircuitBreaker", () => {
  it.effect("opens after the failure threshold and probes after reset", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingTransport.make({
        script: [
          { type: "rejected", error: unavailable() },
          { type: "accepted", providerMessageId: "rec_2" }
        ]
      })
      const transport = yield* EmailTransport.withCircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMillis: 1_000
      })(recorder.transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const first = yield* Email.send(message).pipe(
        Effect.provide(layer),
        Effect.flip
      )
      assert.strictEqual(first._tag, "TransportUnavailable")

      const open = yield* Email.send(message).pipe(
        Effect.provide(layer),
        Effect.flip
      )
      assert.strictEqual(open._tag, "TransportUnavailable")
      assert.strictEqual(
        open._tag === "TransportUnavailable" && open.message,
        "circuit breaker is open"
      )
      assert.strictEqual((yield* recorder.attempts).length, 1)

      yield* TestClock.adjust(1_000)
      const receipt = yield* Email.send(message).pipe(
        Effect.provide(layer)
      )
      assert.strictEqual(
        receipt.providerMessageId,
        providerMessageId("rec_2")
      )

      yield* Email.send(message).pipe(Effect.provide(layer))
      assert.strictEqual((yield* recorder.attempts).length, 3)
    }))

  it.effect("releases an interrupted half-open probe", () =>
    Effect.gen(function* () {
      const destination = makeDestination({
        provider: "probe",
        account: "test"
      })
      let calls = 0
      const transport: EmailTransport.Transport = {
        destination,
        capabilities: EmailTransport.makeCapabilities(),
        send: (envelope) => {
          calls += 1
          if (calls === 1) {
            return Effect.fail(unavailable())
          }
          if (calls === 2) {
            return Effect.never
          }
          return Effect.succeed(
            makeReceipt({
              provider: destination.provider,
              destinationId: destinationId(destination),
              deliveryId: envelope.deliveryId,
              acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
              route: envelope.route
            })
          )
        }
      }
      const circuit = yield* EmailTransport.withCircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMillis: 1_000
      })(transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: circuit }
      })

      yield* Email.send(message).pipe(
        Effect.provide(layer),
        Effect.flip
      )
      yield* TestClock.adjust(1_000)
      const probe = yield* Email.send(message).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(probe)
      yield* Effect.yieldNow

      const receipt = yield* Email.send(message).pipe(
        Effect.provide(layer)
      )
      assert.strictEqual(receipt.provider, "probe")
      assert.strictEqual(calls, 3)
    }))

  it.effect("counts a native batch request as one healthy observation", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        failWhen: (prepared) =>
          prepared.to.some(
            (recipient) => recipient.address === "fail@example.com"
          )
      })
      const transport = yield* EmailTransport.withCircuitBreaker({
        failureThreshold: 1
      })(client.transport)
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const outcomes = yield* Email.sendBatch([
        { to: "good@example.com", subject: "Good", text: "Good" },
        { to: "fail@example.com", subject: "Bad", text: "Bad" }
      ]).pipe(Effect.provide(layer))

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["accepted", "rejected"]
      )

      const receipt = yield* Email.send({
        to: "later@example.com",
        subject: "Later",
        text: "Later"
      }).pipe(Effect.provide(layer))
      assert.strictEqual(receipt.provider, "mock")
    }))
})

const receiptAware = (
  provider: string,
  calls: Array<string>
): EmailTransport.Transport => {
  const destination = makeDestination({ provider, account: "default" })
  return {
    destination,
    capabilities: EmailTransport.makeCapabilities({
      retrieve: true,
      cancel: true
    }),
    send: () => Effect.die("not used"),
    retrieve: (receipt) =>
      Effect.sync(() => {
        calls.push(`retrieve:${provider}`)
        return {
          providerMessageId:
            receipt.providerMessageId ?? providerMessageId("missing"),
          provider,
          state: "delivered" as const
        }
      }),
    cancel: (receipt) =>
      Effect.sync(() => {
        calls.push(`cancel:${provider}`)
        assert.strictEqual(receipt.provider, provider)
      })
  }
}

describe("receipt-routed operations", () => {
  it.effect("routes fallback retrieval and cancellation to the receipt leg", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const primary = receiptAware("primary", calls)
      const secondary = receiptAware("secondary", calls)
      const transport = EmailTransport.withFallback(secondary)(primary)
      const receipt = makeReceipt({
        provider: "secondary",
        destinationId: destinationId(secondary.destination),
        providerMessageId: providerMessageId("secondary_1"),
        acceptedAt: DateTime.makeUnsafe(new Date())
      })
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const status = yield* Email.retrieve(receipt).pipe(
        Effect.provide(layer)
      )
      yield* Email.cancel(receipt).pipe(Effect.provide(layer))

      assert.strictEqual(status.provider, "secondary")
      assert.deepStrictEqual(calls, [
        "retrieve:secondary",
        "cancel:secondary"
      ])
    }))

  it.effect("routes round-robin retrieval to the receipt destination", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const first = receiptAware("first", calls)
      const second = receiptAware("second", calls)
      const transport = EmailTransport.withRoundRobin([first, second])
      const receipt = makeReceipt({
        provider: "second",
        destinationId: destinationId(second.destination),
        providerMessageId: providerMessageId("second_1"),
        acceptedAt: DateTime.makeUnsafe(new Date())
      })
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: transport }
      })

      const status = yield* Email.retrieve(receipt).pipe(
        Effect.provide(layer)
      )

      assert.strictEqual(status.provider, "second")
      assert.deepStrictEqual(calls, ["retrieve:second"])
    }))
})
