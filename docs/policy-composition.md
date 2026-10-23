# Policy composition

Date: 2026-10-22
Baseline: `38f452a` plus PR 3

Policies wrap `Transport` values. They must preserve the operations they claim
and must not turn an uncertain submission into a duplicate send.

## Decorator inventory

| Decorator | `send` | `sendBatch` | `retrieve` / `cancel` | Batch advertisement |
| --- | --- | --- | --- | --- |
| `withRetry` | Retries eligible failures | Preserves native batching; can retry whole batches or opt-in eligible slots | Forwards | Preserves the wrapped capability |
| `withRateLimit` | Charges one request, one message, and recipients | Splits into charged chunks and preserves original indexes | Forwards | Preserves native batching when the wrapped transport supports it |
| `withCircuitBreaker` | One circuit observation per attempt | One observation per batch request; non-native fallback runs per message | Forwards | Preserves native batching when supported |
| `withFallback` | Revalidates the secondary before dispatch | Fails over only safe, non-accepted slots; revalidates each secondary target | Routes by receipt destination/account | Exposes batching when the primary does |
| `withRoundRobin` | Selects an eligible target per send | Uses the selected target for the batch | Routes by receipt destination | Sets `nativeBatch: false` because routing is per logical send |
| `withTee` | Primary plus mirrors | Explicit multiple results | Primary receipt routing | Sets `nativeBatch: false` because mirroring changes the contract |

## Native batch retry

`withRetry` preserves a native batch transport and returns indexed outcomes.

- A whole-batch failure is retried only when the shared retry decision allows it.
- An uncertain whole-batch failure is never retried.
- Partial success is never replayed.
- Partial retry is opt-in with `capabilities.partialBatchRetry: true`. A provider
  may advertise it only when retrying a changed subset with the same
  idempotency context is safe.
- Retried slots keep their original indexes. Accepted, uncertain, and invalid
  slots are not sent again.
- Missing provider outcomes become `uncertain`, not accepted or rejected.

`partialBatchRetry` defaults to `false`. This is intentional: many providers use
one request-level idempotency key, so resubmitting a subset under the same key is
not universally safe.

## Policy order recipes

### Retry primary before fallback

```ts
const transport = withFallback(secondary)(withRetry(policy)(primary))
```

The primary consumes its safe local attempts before fallback is considered. An
uncertain primary result still stops; it is never failed over.

### Fallback group with retry

```ts
const group = withFallback(secondary)(primary)
const transport = withRetry(policy)(group)
```

Retry applies to the group as a logical destination. A receipt accepted by the
secondary remains routed to the secondary for retrieval and cancellation.

### Rate limit each physical attempt

```ts
const transport = withRateLimit(policy)(withRetry(retryPolicy)(primary))
```

Each retry consumes another request token. Use this when provider quota is
charged per HTTP request.

### Rate limit one logical send

```ts
const transport = withRetry(retryPolicy)(withRateLimit(policy)(primary))
```

Internal retries do not consume the outer limiter. Provider quota is still
charged per physical attempt, so document that mismatch explicitly.

## Limiter accounting

`withRateLimit` charges:

- one request per physical batch or single send;
- one message per envelope;
- one recipient per address in `to`, `cc`, and `bcc`.

A native batch is charged by request, message, and recipient. A non-native batch
is split into chunks and charged per chunk. Original indexes are restored after
chunking.

## Fallback rules

- Fail over only known, non-accepted outcomes.
- Never fail over `DeliveryUncertain` or `MalformedProviderResponse`.
- Revalidate the secondary transport's capabilities before dispatch.
- A same-provider second account is a different destination for receipt routing.
- Composite batch and recipient limits use the smaller limit of the two legs so
  a failed subset cannot exceed the secondary's contract.

## Receipt operations

After fallback or round-robin selection, `retrieve` and `cancel` route by the
receipt's destination ID, then by provider when exactly one matching leg exists.
Do not send receipt operations to the primary by default.

## Circuit breaker

- One circuit observation is recorded per physical request.
- A native batch counts as one request-level observation.
- A non-native batch records one observation per message.
- A half-open probe is released if the request is interrupted, so a later caller
  can probe instead of being blocked permanently.
