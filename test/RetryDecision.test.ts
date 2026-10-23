import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  DeliveryUncertain,
  InvalidMessage,
  ProviderRejected,
  RateLimited,
  RecipientSuppressed,
  TransportUnavailable,
  UnsupportedCapability
} from "../src/EmailError"
import { decideRetry } from "../src/RetryDecision"

describe("RetryDecision", () => {
  it.effect("reconciles uncertain outcomes regardless of budget", () =>
    Effect.sync(() => {
      const decision = decideRetry(
        DeliveryUncertain.new({
          message: "outcome unknown",
          provider: "test"
        }),
        { attemptsMade: 10, maxAttempts: 1 }
      )

      assert.strictEqual(decision.action, "reconcile")
      assert.strictEqual(decision.reason, "uncertain")
    }))

  it.effect("stops permanent local failures", () =>
    Effect.sync(() => {
      const invalid = decideRetry(
        new InvalidMessage({ message: "invalid" })
      )
      const unsupported = decideRetry(
        UnsupportedCapability.new({
          message: "unsupported",
          capability: "attachments"
        })
      )
      const suppressed = decideRetry(
        new RecipientSuppressed({
          message: "suppressed",
          recipients: ["user@example.com"]
        })
      )

      assert.strictEqual(invalid.action, "stop")
      assert.strictEqual(invalid.reason, "permanent")
      assert.strictEqual(unsupported.action, "stop")
      assert.strictEqual(suppressed.action, "stop")
    }))

  it.effect("retries transient and rate-limited failures", () =>
    Effect.sync(() => {
      const transient = decideRetry(
        TransportUnavailable.new({
          message: "temporary",
          provider: "test",
          retryable: true
        })
      )
      const limited = decideRetry(
        RateLimited.new({
          message: "slow down",
          provider: "test",
          retryAfterMillis: 750
        })
      )

      assert.strictEqual(transient.action, "retry")
      assert.strictEqual(transient.reason, "transient")
      assert.strictEqual(limited.action, "retry")
      assert.strictEqual(limited.reason, "rate-limited")
      assert.strictEqual(limited.delayMillis, 750)
    }))

  it.effect("retries only explicitly retryable rejections", () =>
    Effect.sync(() => {
      const retryable = decideRetry(
        ProviderRejected.new({
          message: "try later",
          provider: "test",
          status: 503,
          retryable: true
        })
      )
      const permanent = decideRetry(
        ProviderRejected.new({
          message: "bad request",
          provider: "test",
          status: 400,
          retryable: false
        })
      )

      assert.strictEqual(retryable.action, "retry")
      assert.strictEqual(permanent.action, "stop")
      assert.strictEqual(permanent.reason, "permanent")
    }))

  it.effect("stops when the attempt budget is exhausted", () =>
    Effect.sync(() => {
      const decision = decideRetry(
        TransportUnavailable.new({
          message: "temporary",
          provider: "test",
          retryable: true
        }),
        { attemptsMade: 3, maxAttempts: 3, defaultDelayMillis: 1_000 }
      )

      assert.strictEqual(decision.action, "stop")
      assert.strictEqual(decision.reason, "exhausted")
    }))

  it.effect("uses the default delay and honors a custom predicate", () =>
    Effect.sync(() => {
      const defaultDelay = decideRetry(
        TransportUnavailable.new({
          message: "temporary",
          provider: "test",
          retryable: true
        }),
        { defaultDelayMillis: 1_000 }
      )
      const custom = decideRetry(
        new InvalidMessage({ message: "invalid" }),
        { retryable: () => true }
      )

      assert.strictEqual(defaultDelay.delayMillis, 1_000)
      assert.strictEqual(custom.action, "retry")
    }))
})
