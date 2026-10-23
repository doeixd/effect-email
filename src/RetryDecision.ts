import {
  certaintyOf,
  isRetryable,
  type EmailError
} from "./EmailError"

export type RetryAction = "stop" | "retry" | "reconcile"

export type RetryReason =
  | "uncertain"
  | "exhausted"
  | "permanent"
  | "transient"
  | "rate-limited"

export interface RetryDecisionOptions {
  readonly attemptsMade?: number
  readonly maxAttempts?: number
  readonly defaultDelayMillis?: number
  readonly retryable?: (error: EmailError) => boolean
}

export interface RetryDecision {
  readonly action: RetryAction
  readonly reason: RetryReason
  readonly delayMillis?: number
}

export const decideRetry = (
  error: EmailError,
  options: RetryDecisionOptions = {}
): RetryDecision => {
  if (certaintyOf(error) === "unknown") {
    return { action: "reconcile", reason: "uncertain" }
  }

  const attemptsMade = options.attemptsMade ?? 0
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
  if (attemptsMade >= maxAttempts) {
    return { action: "stop", reason: "exhausted" }
  }

  const retryable = options.retryable ?? isRetryable
  if (!retryable(error)) {
    return { action: "stop", reason: "permanent" }
  }

  const retryAfterMillis =
    "retryAfterMillis" in error
      ? error.retryAfterMillis
      : undefined
  const delayMillis = retryAfterMillis ?? options.defaultDelayMillis
  return {
    action: "retry",
    reason: error._tag === "RateLimited" ? "rate-limited" : "transient",
    ...(delayMillis === undefined ? {} : { delayMillis })
  }
}
