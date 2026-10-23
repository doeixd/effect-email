import { Clock, Context, Duration, Effect, Layer, Ref, Schedule } from "effect"
import { RateLimiter } from "effect/persistence"
import type { Destination } from "./Ids"
import { destinationId, makeDestination } from "./Ids"
import type { MailboxInput } from "./Message"
import { normalizeMailbox } from "./Message"
import { checkCapabilities } from "./Capabilities"
import type { EmailError, TransportError } from "./EmailError"
import { decideRetry } from "./RetryDecision"
import {
  certaintyOf,
  DeliveryUncertain,
  isRetryable,
  TransportUnavailable,
  UnsupportedCapability
} from "./EmailError"
import type {
  DeliveryStatus,
  MessageOutcome,
  PreparedEnvelope,
  SubmissionReceipt
} from "./Submission"

export interface TransportCapabilities {
  readonly nativeBatch: boolean
  readonly partialBatchRetry?: boolean
  readonly maxBatchSize?: number
  readonly maxRecipientsPerMessage?: number
  readonly attachments: boolean
  readonly remoteAttachments: boolean
  readonly rawMime: boolean
  readonly tags: boolean
  readonly localTemplates: boolean
  readonly providerTemplates: boolean
  readonly retrieve: boolean
  readonly cancel: boolean
  readonly idempotency: "none" | "request" | "message"
  readonly idempotencyWindowMillis?: number
}

export const defaultCapabilities: TransportCapabilities = {
  nativeBatch: false,
  partialBatchRetry: false,
  attachments: true,
  remoteAttachments: false,
  rawMime: false,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
}

export const makeCapabilities = (
  overrides: Partial<TransportCapabilities> = {}
): TransportCapabilities => ({ ...defaultCapabilities, ...overrides })

export interface Transport {
  readonly destination: Destination
  readonly capabilities: TransportCapabilities
  readonly send: (
    envelope: PreparedEnvelope
  ) => Effect.Effect<SubmissionReceipt, TransportError>
  readonly retrieve?: (
    receipt: SubmissionReceipt
  ) => Effect.Effect<DeliveryStatus, TransportError>
  readonly cancel?: (
    receipt: SubmissionReceipt
  ) => Effect.Effect<void, TransportError>
}

export interface NativeBatchTransport extends Transport {
  readonly capabilities: TransportCapabilities & { readonly nativeBatch: true }
  readonly sendBatch: (
    envelopes: ReadonlyArray<PreparedEnvelope>
  ) => Effect.Effect<ReadonlyArray<MessageOutcome>, TransportError>
}

export const isNativeBatchTransport = (
  transport: Transport
): transport is NativeBatchTransport =>
  transport.capabilities.nativeBatch &&
  "sendBatch" in transport &&
  typeof transport.sendBatch === "function"

export interface RetryPolicy {
  readonly maxAttempts?: number
  readonly baseDelayMillis?: number
  readonly maxDelayMillis?: number
  readonly jitter?: boolean
  readonly retryable?: (error: TransportError) => boolean
}

export const withRetry =
  (policy: RetryPolicy = {}) =>
  (transport: Transport): Transport => {
    const maxAttempts = Math.max(1, policy.maxAttempts ?? 3)
    const base = policy.baseDelayMillis ?? 250
    const max = policy.maxDelayMillis ?? 30_000

    const delayFor = (attempt: number, error: EmailError): number => {
      const backoff = Math.min(
        max,
        base * 2 ** (Math.max(1, attempt) - 1)
      )
      const jittered =
        policy.jitter === true
          ? Math.round(backoff * (0.5 + Math.random() * 0.5))
          : backoff
      const retryAfterMillis =
        "retryAfterMillis" in error
          ? error.retryAfterMillis ?? 0
          : 0
      return Math.max(jittered, retryAfterMillis)
    }

    const decisionFor = (error: EmailError, attemptsMade: number) =>
      decideRetry(error, {
        attemptsMade,
        maxAttempts,
        ...(policy.retryable === undefined
          ? {}
          : {
              retryable: (failure) =>
                policy.retryable?.(failure as TransportError) ?? false
            })
      })

    const schedule = Schedule.recurs(maxAttempts - 1).pipe(
      Schedule.modifyDelay(({ attempt, input }) =>
        Effect.succeed(
          Duration.millis(delayFor(attempt, input as TransportError))
        )
      )
    )

    const retrying = <A>(
      effect: Effect.Effect<A, TransportError>
    ): Effect.Effect<A, TransportError> =>
      effect.pipe(
        Effect.retry({
          while: (error) => decisionFor(error, 0).action === "retry",
          schedule
        })
      )

    const send: Transport["send"] = (envelope) =>
      retrying(transport.send(envelope))

    const decorated: Transport = {
      destination: transport.destination,
      capabilities: transport.capabilities,
      send,
      ...(transport.retrieve === undefined
        ? {}
        : { retrieve: transport.retrieve }),
      ...(transport.cancel === undefined ? {} : { cancel: transport.cancel })
    }
    if (!isNativeBatchTransport(transport)) {
      return decorated
    }

    const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fnUntraced(
      function* (envelopes) {
        if (
          envelopes.length === 0 ||
          transport.capabilities.partialBatchRetry !== true
        ) {
          return yield* retrying(transport.sendBatch(envelopes))
        }

        const outcomes = new Map<number, MessageOutcome>()
        let pending = envelopes.map((envelope, index) => ({
          envelope,
          index
        }))
        let round = 0

        while (pending.length > 0) {
          const result = yield* Effect.result(
            transport.sendBatch(pending.map((slot) => slot.envelope))
          )
          if (result._tag === "Failure") {
            const decision = decisionFor(result.failure, round + 1)
            if (decision.action === "retry") {
              const delay =
                decision.delayMillis ??
                delayFor(round + 1, result.failure)
              if (delay > 0) {
                yield* Effect.sleep(Duration.millis(delay))
              }
              round += 1
              continue
            }
            for (const slot of pending) {
              outcomes.set(
                slot.index,
                failureOutcome(slot.index, result.failure)
              )
            }
            break
          }

          const byLocalIndex = new Map(
            normalizeOutcomes(pending.map((slot) => slot.envelope), result.success)
              .map((outcome) => [outcome.index, outcome])
          )
          const retrySlots: typeof pending = []
          const retryDelays: Array<number> = []
          for (const [position, slot] of pending.entries()) {
            const outcome = byLocalIndex.get(position)
            if (outcome === undefined) {
              outcomes.set(
                slot.index,
                failureOutcome(
                  slot.index,
                  DeliveryUncertain.new({
                    message:
                      "provider batch response omitted this message",
                    provider: transport.destination.provider
                  })
                )
              )
              continue
            }
            const mapped = { ...outcome, index: slot.index }
            if (mapped._tag === "rejected") {
              const decision = decisionFor(mapped.error, round + 1)
              if (decision.action === "retry") {
                retrySlots.push(slot)
                retryDelays.push(
                  decision.delayMillis ??
                    delayFor(round + 1, mapped.error)
                )
                continue
              }
            }
            outcomes.set(slot.index, mapped)
          }

          if (retrySlots.length === 0) {
            break
          }
          const delay = Math.max(...retryDelays)
          if (delay > 0) {
            yield* Effect.sleep(Duration.millis(delay))
          }
          pending = retrySlots
          round += 1
        }

        return [...outcomes.values()].sort(
          (left, right) => left.index - right.index
        )
      }
    )

    return { ...decorated, sendBatch } as NativeBatchTransport
  }

export interface FallbackOptions {
  readonly shouldFailover?: (error: EmailError) => boolean
  readonly onFailover?: (
    from: Transport,
    to: Transport,
    error: EmailError
  ) => void
}

const defaultShouldFailover = (error: EmailError): boolean =>
  error._tag !== "InvalidMessage" && error._tag !== "UnsupportedCapability"

const reroute = (
  envelope: PreparedEnvelope,
  transport: Transport
): PreparedEnvelope => ({
  ...envelope,
  destination: transport.destination,
  destinationId: destinationId(transport.destination)
})

const receiptTransport = (
  transports: ReadonlyArray<Transport>,
  receipt: SubmissionReceipt
): Transport | undefined => {
  const direct = transports.find(
    (transport) =>
      destinationId(transport.destination) === receipt.destinationId
  )
  if (direct !== undefined) {
    return direct
  }
  const matching = transports.filter(
    (transport) => transport.destination.provider === receipt.provider
  )
  return matching.length === 1 ? matching[0] : undefined
}

const unsupportedReceiptOperation = (
  receipt: SubmissionReceipt,
  capability: "retrieve" | "cancel"
): UnsupportedCapability =>
  UnsupportedCapability.new({
    message: `destination does not support ${capability}: ${receipt.destinationId}`,
    provider: receipt.provider,
    capability
  })

const failureOutcome = (index: number, error: EmailError): MessageOutcome =>
  certaintyOf(error) === "unknown"
    ? { _tag: "uncertain", index, error }
    : { _tag: "rejected", index, error }

const normalizeOutcomes = (
  envelopes: ReadonlyArray<PreparedEnvelope>,
  outcomes: ReadonlyArray<MessageOutcome>
): ReadonlyArray<MessageOutcome> => {
  const indexed = new Map<number, MessageOutcome>()
  const duplicates = new Set<number>()
  for (const outcome of outcomes) {
    if (!Number.isInteger(outcome.index) || outcome.index < 0 || outcome.index >= envelopes.length) continue
    if (indexed.has(outcome.index)) duplicates.add(outcome.index)
    indexed.set(outcome.index, outcome)
  }
  return envelopes.map((envelope, index) => {
    const outcome = indexed.get(index)
    return outcome !== undefined && !duplicates.has(index) ? outcome : failureOutcome(index,
      DeliveryUncertain.new({
        message: "provider batch response omitted or duplicated this message",
        provider: envelope.destination.provider
      })
    )
  })
}

const runOutcomes = (
  transport: Transport,
  envelopes: ReadonlyArray<PreparedEnvelope>
): Effect.Effect<ReadonlyArray<MessageOutcome>> => {
  if (isNativeBatchTransport(transport)) {
    return Effect.result(transport.sendBatch(envelopes)).pipe(
      Effect.map((result) =>
        result._tag === "Failure"
          ? envelopes.map((_, index) =>
              failureOutcome(index, result.failure)
            )
          : normalizeOutcomes(envelopes, result.success)
      )
    )
  }
  return Effect.forEach(envelopes, (envelope, index) =>
    Effect.result(transport.send(envelope)).pipe(
      Effect.map((result) =>
        result._tag === "Failure"
          ? failureOutcome(index, result.failure)
          : {
              _tag: "accepted" as const,
              index,
              receipt: result.success
            }
      )
    )
  )
}

export interface RateLimitWindow {
  readonly limit: number
  readonly intervalMillis: number
  readonly algorithm?: "fixed-window" | "token-bucket"
}

export interface RateLimitPolicy {
  readonly key?: string
  readonly requests?: RateLimitWindow
  readonly messages?: RateLimitWindow
  readonly recipients?: RateLimitWindow
}

export const layerRateLimiterMemory: Layer.Layer<RateLimiter.RateLimiter> =
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))

const recipientCount = (
  envelopes: ReadonlyArray<PreparedEnvelope>
): number =>
  envelopes.reduce(
    (total, envelope) =>
      total +
      (envelope.rawEnvelope?.rcptTo.length ?? (
        envelope.message.to.length + envelope.message.cc.length + envelope.message.bcc.length
      )),
    0
  )

const splitForRateLimit = (
  envelopes: ReadonlyArray<PreparedEnvelope>,
  policy: RateLimitPolicy
): ReadonlyArray<ReadonlyArray<PreparedEnvelope>> => {
  const maxMessages = policy.messages?.limit
  const maxRecipients = policy.recipients?.limit
  if (maxMessages === undefined && maxRecipients === undefined) {
    return [envelopes]
  }
  const chunks: Array<Array<PreparedEnvelope>> = []
  let current: Array<PreparedEnvelope> = []
  let recipients = 0
  for (const envelope of envelopes) {
    const size = recipientCount([envelope])
    const full =
      (maxMessages !== undefined && current.length >= maxMessages) ||
      (maxRecipients !== undefined && recipients + size > maxRecipients)
    if (current.length > 0 && full) {
      chunks.push(current)
      current = []
      recipients = 0
    }
    current.push(envelope)
    recipients += size
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

export const withRateLimit =
  (policy: RateLimitPolicy) =>
  (
    transport: Transport
  ): Effect.Effect<Transport, never, RateLimiter.RateLimiter> =>
    Effect.gen(function* () {
      for (const [name, window] of Object.entries(policy)) {
        if (name === "key" || window === undefined) {
          continue
        }
        if (
          !Number.isFinite(window.limit) ||
          window.limit <= 0 ||
          !Number.isFinite(window.intervalMillis) ||
          window.intervalMillis <= 0
        ) {
          return yield* Effect.die(
            new Error(
              `${name} rate limit requires a positive limit and interval`
            )
          )
        }
      }

      const limiter = yield* RateLimiter.RateLimiter
      const key = policy.key ?? destinationId(transport.destination)

      const consume = (
        name: string,
        window: RateLimitWindow | undefined,
        tokens: number
      ): Effect.Effect<void, TransportError> => {
        if (window === undefined || tokens <= 0) {
          return Effect.void
        }
        if (tokens > window.limit) {
          return Effect.fail(
            UnsupportedCapability.new({
              message: `${name} rate limit (${window.limit}) is smaller than the requested ${tokens}`,
              provider: transport.destination.provider,
              capability: `rate-limit:${name}`
            })
          )
        }
        return RateLimiter.sleep(limiter, {
          key: `${key}:${name}`,
          window: Duration.millis(window.intervalMillis),
          limit: window.limit,
          tokens,
          algorithm: window.algorithm ?? "token-bucket"
        }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              TransportUnavailable.new({
                message: `rate limiter failed for ${name}`,
                provider: transport.destination.provider,
                retryable: true,
                cause
              })
          )
        )
      }

      const acquire = (
        envelopes: ReadonlyArray<PreparedEnvelope>
      ): Effect.Effect<void, TransportError> =>
        Effect.gen(function* () {
          yield* consume("requests", policy.requests, 1)
          yield* consume("messages", policy.messages, envelopes.length)
          yield* consume(
            "recipients",
            policy.recipients,
            recipientCount(envelopes)
          )
        })

      const send: Transport["send"] = Effect.fnUntraced(function* (
        envelope
      ) {
        yield* acquire([envelope])
        return yield* transport.send(envelope)
      })

      const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fnUntraced(
        function* (envelopes) {
          if (envelopes.length === 0) {
            return []
          }
          const outcomes: Array<MessageOutcome> = []
          let offset = 0
          for (const chunk of splitForRateLimit(envelopes, policy)) {
            const acquired = yield* Effect.result(acquire(chunk))
            const result = acquired._tag === "Failure"
              ? chunk.map((_, index) => failureOutcome(index, acquired.failure))
              : yield* runOutcomes(transport, chunk)
            for (const outcome of result) {
              outcomes.push({
                ...outcome,
                index: outcome.index + offset
              })
            }
            offset += chunk.length
          }
          return outcomes
        }
      )

      const decorated: Transport = {
        destination: transport.destination,
        capabilities: transport.capabilities,
        send,
        ...(transport.retrieve === undefined
          ? {}
          : { retrieve: transport.retrieve }),
        ...(transport.cancel === undefined
          ? {}
          : { cancel: transport.cancel })
      }
      return isNativeBatchTransport(transport)
        ? ({ ...decorated, sendBatch } as NativeBatchTransport)
        : decorated
    })

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number
  readonly resetTimeoutMillis?: number
  readonly failureWhen?: (error: TransportError) => boolean
}

type CircuitStatus = "closed" | "open" | "half-open"

interface CircuitState {
  readonly status: CircuitStatus
  readonly failures: number
  readonly openedAt?: number
  readonly probeInFlight: boolean
}

type CircuitDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly retryAfterMillis: number }

export const withCircuitBreaker =
  (options: CircuitBreakerOptions = {}) =>
  (transport: Transport): Effect.Effect<Transport> =>
    Effect.gen(function* () {
      const failureThreshold = options.failureThreshold ?? 5
      const resetTimeoutMillis = options.resetTimeoutMillis ?? 30_000
      if (
        !Number.isFinite(failureThreshold) ||
        failureThreshold < 1 ||
        !Number.isFinite(resetTimeoutMillis) ||
        resetTimeoutMillis < 0
      ) {
        return yield* Effect.die(
          new Error(
            "circuit breaker requires a positive failure threshold and a non-negative reset timeout"
          )
        )
      }
      const failureWhen = options.failureWhen ?? isRetryable
      const state = yield* Ref.make<CircuitState>({
        status: "closed",
        failures: 0,
        probeInFlight: false
      })

      const acquire = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const decision = yield* Ref.modify(
          state,
          (current): readonly [CircuitDecision, CircuitState] => {
            if (current.status === "closed") {
              return [{ kind: "allowed" }, current]
            }
            const elapsed =
              current.openedAt === undefined
                ? 0
                : Math.max(0, now - current.openedAt)
            if (current.status === "open") {
              if (elapsed >= resetTimeoutMillis) {
                return [
                  { kind: "allowed" },
                  {
                    ...current,
                    status: "half-open",
                    probeInFlight: true
                  }
                ]
              }
              return [
                {
                  kind: "blocked",
                  retryAfterMillis: resetTimeoutMillis - elapsed
                },
                current
              ]
            }
            if (!current.probeInFlight) {
              return [
                { kind: "allowed" },
                { ...current, probeInFlight: true }
              ]
            }
            return [
              { kind: "blocked", retryAfterMillis: 0 },
              current
            ]
          }
        )
        if (decision.kind === "blocked") {
          return yield* TransportUnavailable.new({
            message: "circuit breaker is open",
            provider: transport.destination.provider,
            retryable: true,
            retryAfterMillis: decision.retryAfterMillis
          })
        }
      })

      const record = (healthy: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* Ref.update(state, (current) => {
            if (healthy) {
              return {
                status: "closed" as const,
                failures: 0,
                probeInFlight: false
              }
            }
            if (current.status === "half-open") {
              return {
                status: "open" as const,
                failures: current.failures + 1,
                openedAt: now,
                probeInFlight: false
              }
            }
            const failures = current.failures + 1
            return failures >= failureThreshold
              ? {
                  status: "open" as const,
                  failures,
                  openedAt: now,
                  probeInFlight: false
                }
              : {
                  ...current,
                  failures,
                  probeInFlight: false
                }
          })
        })

      const releaseProbe = Ref.update(state, (current) =>
        current.status === "half-open"
          ? { ...current, probeInFlight: false }
          : current
      )

      const run = <A>(
        operation: Effect.Effect<A, TransportError>,
        healthy: (value: A) => boolean = () => true
      ): Effect.Effect<A, TransportError> =>
        Effect.gen(function* () {
          yield* acquire
          const result = yield* Effect.result(operation).pipe(
            Effect.ensuring(releaseProbe)
          )
          if (result._tag === "Success") {
            yield* record(healthy(result.success))
            return result.success
          }
          yield* record(!failureWhen(result.failure))
          return yield* result.failure
        })

      const send: Transport["send"] = Effect.fnUntraced(function* (
        envelope
      ) {
        return yield* run(transport.send(envelope))
      })

      const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fnUntraced(
        function* (envelopes) {
          if (!isNativeBatchTransport(transport)) {
            const outcomes: Array<MessageOutcome> = []
            for (const [index, envelope] of envelopes.entries()) {
              const result = yield* Effect.result(send(envelope))
              outcomes.push(
                result._tag === "Success"
                  ? { _tag: "accepted", index, receipt: result.success }
                  : failureOutcome(index, result.failure)
              )
            }
            return outcomes
          }
          return yield* run(transport.sendBatch(envelopes), (outcomes) =>
            !outcomes.some((outcome) => outcome._tag !== "accepted" && failureWhen(outcome.error as TransportError))
          )
        }
      )

      const decorated: Transport = {
        destination: transport.destination,
        capabilities: transport.capabilities,
        send,
        ...(transport.retrieve === undefined
          ? {}
          : { retrieve: transport.retrieve }),
        ...(transport.cancel === undefined
          ? {}
          : { cancel: transport.cancel })
      }
      return isNativeBatchTransport(transport)
        ? ({ ...decorated, sendBatch } as NativeBatchTransport)
        : decorated
    })

export const withFallback =
  (secondary: Transport, options: FallbackOptions = {}) =>
  (primary: Transport): Transport => {
    const shouldFailover = options.shouldFailover ?? defaultShouldFailover

    const send: Transport["send"] = Effect.fnUntraced(function* (envelope) {
      const first = yield* Effect.result(primary.send(envelope))
      if (first._tag === "Success") {
        return first.success
      }
      if (
        certaintyOf(first.failure) === "unknown" ||
        !shouldFailover(first.failure)
      ) {
        return yield* first.failure
      }
      const routed = reroute(envelope, secondary)
      yield* checkCapabilities(secondary, routed.message, routed.rawEnvelope)
      options.onFailover?.(primary, secondary, first.failure)
      return yield* secondary.send(routed)
    })

    const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fnUntraced(
      function* (envelopes) {
        const first = yield* runOutcomes(primary, envelopes)
        const pending: Array<number> = []
        for (const [index, outcome] of first.entries()) {
          if (
            outcome._tag !== "accepted" &&
            certaintyOf(outcome.error) !== "unknown" &&
            shouldFailover(outcome.error)
          ) {
            pending.push(index)
          }
        }
        if (pending.length === 0) {
          return first
        }
        const merged = [...first]
        const secondaryEnvelopes: Array<PreparedEnvelope> = []
        const secondarySlots: Array<number> = []
        for (const index of pending) {
          const routed = reroute(envelopes[index]!, secondary)
          const checked = yield* Effect.result(
            checkCapabilities(secondary, routed.message, routed.rawEnvelope)
          )
          if (checked._tag === "Failure") {
            merged[index] = failureOutcome(index, checked.failure)
            continue
          }
          secondaryEnvelopes.push(routed)
          secondarySlots.push(index)
        }
        if (secondaryEnvelopes.length === 0) {
          return merged.sort((left, right) => left.index - right.index)
        }
        const next = yield* runOutcomes(secondary, secondaryEnvelopes)
        for (const [slot, index] of secondarySlots.entries()) {
          const outcome = next[slot]
          if (outcome !== undefined) {
            merged[index] = { ...outcome, index }
          }
        }
        return merged.sort((left, right) => left.index - right.index)
      }
    )

    const legs = [primary, secondary]
    const minLimit = (left?: number, right?: number): number | undefined =>
      left === undefined
        ? right
        : right === undefined
          ? left
          : Math.min(left, right)
    const maxBatchSize = minLimit(
      primary.capabilities.maxBatchSize,
      secondary.capabilities.maxBatchSize
    )
    const maxRecipientsPerMessage = minLimit(
      primary.capabilities.maxRecipientsPerMessage,
      secondary.capabilities.maxRecipientsPerMessage
    )
    const capabilities: TransportCapabilities = {
      ...primary.capabilities,
      retrieve:
        primary.capabilities.retrieve ||
        secondary.capabilities.retrieve,
      cancel:
        primary.capabilities.cancel || secondary.capabilities.cancel,
      ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
      ...(maxRecipientsPerMessage === undefined
        ? {}
        : { maxRecipientsPerMessage })
    }

    const retrieve: Transport["retrieve"] = (receipt) => {
      const transport = receiptTransport(legs, receipt)
      if (transport?.retrieve === undefined) {
        return Effect.fail(
          unsupportedReceiptOperation(receipt, "retrieve")
        )
      }
      return transport.retrieve(receipt)
    }

    const cancel: Transport["cancel"] = (receipt) => {
      const transport = receiptTransport(legs, receipt)
      if (transport?.cancel === undefined) {
        return Effect.fail(
          unsupportedReceiptOperation(receipt, "cancel")
        )
      }
      return transport.cancel(receipt)
    }

    return {
      destination: primary.destination,
      capabilities,
      send,
      sendBatch,
      retrieve,
      cancel
    } as NativeBatchTransport
  }

export interface TeeMirrorResult {
  readonly index: number
  readonly transport: Transport
  readonly receipt?: SubmissionReceipt
  readonly error?: EmailError
}

export interface TeeOutcome {
  readonly primary: SubmissionReceipt
  readonly mirrors: ReadonlyArray<TeeMirrorResult>
}

export interface TeeOptions {
  readonly mirrorTo?: MailboxInput
  readonly onSecondaryError?: (failure: TeeMirrorResult) => void
}

export interface TeeTransport extends Transport {
  readonly tee: (
    envelope: PreparedEnvelope
  ) => Effect.Effect<TeeOutcome, TransportError>
}

const mirrorEnvelope = (
  envelope: PreparedEnvelope,
  mirrorTo: MailboxInput | undefined,
  transport: Transport
): PreparedEnvelope => {
  const routed = {
    ...envelope,
    destination: transport.destination,
    destinationId: destinationId(transport.destination)
  }
  if (mirrorTo === undefined) {
    return routed
  }
  const recipient = normalizeMailbox(mirrorTo)
  return {
    ...routed,
    ...(envelope.rawEnvelope === undefined
      ? {}
      : { rawEnvelope: { ...envelope.rawEnvelope, rcptTo: [recipient.address] } }),
    message: {
      ...envelope.message,
      to: [recipient],
      cc: [],
      bcc: []
    }
  }
}

export const withTee = (
  primary: Transport,
  secondaries: ReadonlyArray<Transport>,
  options: TeeOptions = {}
): TeeTransport => {
  const tee = Effect.fnUntraced(function* (
    envelope: PreparedEnvelope
  ) {
    const primaryResult = yield* Effect.result(primary.send(envelope))
    if (primaryResult._tag === "Failure") {
      return yield* primaryResult.failure
    }
    const mirrors = yield* Effect.forEach(
      secondaries,
      (transport, index) =>
        Effect.result(
          transport.send(
            mirrorEnvelope(envelope, options.mirrorTo, transport)
          )
        ).pipe(
          Effect.map((result): TeeMirrorResult =>
            result._tag === "Success"
              ? { index, transport, receipt: result.success }
              : { index, transport, error: result.failure }
          )
        ),
      { concurrency: "unbounded" }
    )
    for (const mirror of mirrors) {
      if (mirror.error !== undefined) {
        options.onSecondaryError?.(mirror)
      }
    }
    return { primary: primaryResult.success, mirrors }
  })

  const send: Transport["send"] = (envelope) =>
    Effect.map(tee(envelope), (outcome) => outcome.primary)

  return {
    destination: primary.destination,
    capabilities: makeCapabilities({
      ...primary.capabilities,
      nativeBatch: false
    }),
    send,
    tee,
    ...(primary.retrieve === undefined
      ? {}
      : { retrieve: primary.retrieve }),
    ...(primary.cancel === undefined ? {} : { cancel: primary.cancel })
  }
}

export const withRoundRobin = (
  transports: ReadonlyArray<Transport>
): Transport => {
  if (transports.length === 0) {
    throw new Error("withRoundRobin requires at least one transport")
  }

  const idempotencyRank = (value: Transport["capabilities"]["idempotency"]) =>
    value === "message" ? 2 : value === "request" ? 1 : 0
  const weakestIdempotency = transports.reduce<
    Transport["capabilities"]["idempotency"]
  >(
    (weakest, transport) =>
      idempotencyRank(transport.capabilities.idempotency) <
      idempotencyRank(weakest)
        ? transport.capabilities.idempotency
        : weakest,
    "message"
  )
  const recipientLimits = transports.map(
    (transport) => transport.capabilities.maxRecipientsPerMessage
  )
  const all = (predicate: (transport: Transport) => boolean) =>
    transports.every(predicate)
  const windows = transports.map(
    (transport) => transport.capabilities.idempotencyWindowMillis
  )
  const capabilities: TransportCapabilities = makeCapabilities({
    nativeBatch: false,
    ...(recipientLimits.some((limit) => limit === undefined)
      ? {}
      : { maxRecipientsPerMessage: Math.min(...(recipientLimits as Array<number>)) }),
    attachments: all((transport) => transport.capabilities.attachments),
    remoteAttachments: all(
      (transport) => transport.capabilities.remoteAttachments
    ),
    rawMime: all((transport) => transport.capabilities.rawMime),
    tags: all((transport) => transport.capabilities.tags),
    localTemplates: all((transport) => transport.capabilities.localTemplates),
    providerTemplates: all(
      (transport) => transport.capabilities.providerTemplates
    ),
    retrieve: all((transport) => transport.capabilities.retrieve),
    cancel: all((transport) => transport.capabilities.cancel),
    idempotency: weakestIdempotency,
    ...(weakestIdempotency === "none" || windows.some((window) => window === undefined)
      ? {}
      : { idempotencyWindowMillis: Math.min(...(windows as Array<number>)) })
  })

  const destination = makeDestination({
    provider: "round-robin",
    account: transports
      .map((transport) => destinationId(transport.destination))
      .join("|")
  })

  let cursor = 0
  const pinned = new WeakMap<PreparedEnvelope, Transport>()

  const send: Transport["send"] = Effect.fnUntraced(function* (envelope) {
    let transport = pinned.get(envelope)
    if (transport === undefined) {
      transport = transports[cursor % transports.length]!
      cursor += 1
      pinned.set(envelope, transport)
    }
    return yield* transport.send(envelope)
  })

  const retrieve: Transport["retrieve"] = (receipt) => {
    const transport = receiptTransport(transports, receipt)
    if (transport?.retrieve === undefined) {
      return Effect.fail(
        unsupportedReceiptOperation(receipt, "retrieve")
      )
    }
    return transport.retrieve(receipt)
  }

  const cancel: Transport["cancel"] = (receipt) => {
    const transport = receiptTransport(transports, receipt)
    if (transport?.cancel === undefined) {
      return Effect.fail(
        unsupportedReceiptOperation(receipt, "cancel")
      )
    }
    return transport.cancel(receipt)
  }

  return { destination, capabilities, send, retrieve, cancel }
}
export class EmailTransport extends Context.Service<EmailTransport, Transport>()(
  "@effect-email/EmailTransport"
) {
  static layer(transport: Transport): Layer.Layer<EmailTransport> {
    return Layer.succeed(EmailTransport, transport)
  }
}

export const layer = EmailTransport.layer

export const destinationOf = (transport: Transport): Destination =>
  transport.destination


