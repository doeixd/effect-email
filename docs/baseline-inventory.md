# Delivery baseline inventory

Date: 2026-10-22
Baseline: `f817a95` (PR 5 partial)
Roadmap: `docs/service-improvement-plan.md`
Lifecycle decision: `docs/adr/0001-delivery-lifecycle.md`

This inventory describes the implementation as it exists, not the target
architecture. It is the reference point for the service improvement roadmap.

## Verification

- `bun run typecheck`: pass.
- `bun run check`: pass, 274 tests across 58 files.
- PostgreSQL integration: pass against PostgreSQL 17 with two tests covering
  transactional rollback and concurrent delivery isolation.
- `bun run smoke`: pass against the built package.
- Package entry-point guard: pass; the root entrypoint exports core modules
  only and does not load providers, Node adapters, or server modules.

## Adoption levels

| Level | Assembly | Durability | Current guarantee |
| --- | --- | --- | --- |
| Direct | `Email.layerTransport` or `Email.layer` with static routes | None | Prepares and submits one attempt through the selected transport |
| Resilient | Direct plus `EmailTransport` policy wrappers | None | Adds bounded local retry, fallback, throttling, or circuit breaking |
| Durable | `SubmissionAdmission` + `DeliveryStore` + persisted queue + worker/publisher/reconciler | Depends on store and queue layers | Admission is durable; dispatch and recovery are tracked, but external delivery is not exactly once |

Memory-backed stores, queues, workflow engines, and spools do not survive process
loss. `WorkflowEngine.layerMemory` is a development facility.

## Public surface

| Area | Entry points | Current behavior | Source |
| --- | --- | --- | --- |
| Message preparation | `Message`, `Email.send`, `Email.sendBatch` | Normalizes addresses, validates content, renders templates, checks capabilities | `src/Message.ts`, `src/Email.ts`, `src/render/Template.ts` |
| Direct send | `Email.layer`, `Email.layerTransport`, `Email.send` | Resolves a static route and returns a `SubmissionReceipt` | `src/Email.ts` |
| Batch and stream | `Email.sendBatch`, `Email.sendStream` | Retains original slot indexes and maps native batches; bounded stream chunks | `src/Email.ts` |
| Policies | `withRetry`, `withFallback`, `withRoundRobin`, `withTee`, `withRateLimit`, `withCircuitBreaker` | Local policies over transport values; native batch dispatch is preserved by retry; fallback revalidates the secondary; partial batch retry is opt-in | `src/EmailTransport.ts`, `src/Capabilities.ts` |
| Registry | `TransportRegistry`, `Email.layerFromRegistry`, `Email.layerFromRegistryLayer` | Routes are resolved while the Email layer is built; there is no hot reconfiguration | `src/TransportRegistry.ts`, `src/Email.ts` |
| Providers | Provider-specific `make`, layer, client, and transport constructors | 24 provider/infrastructure adapters plus local catchers and `Mock` | `src/providers/` |
| Admission | `SubmissionAdmission.accept`, `acceptRaw`, `get`, `cancel`, `redrive` | Authorizes, optionally checks suppression, snapshots content, and persists an intent | `src/SubmissionAdmission.ts` |
| Delivery store | `DeliveryStore` with memory and SQL layers | Durable intent, claim, attempt, event, cancellation, and retention state; memory and SQL share pure lifecycle transitions | `src/DeliveryStore.ts`, `src/DeliveryStoreSql.ts`, `src/DeliveryTransitions.ts` |
| Queue and recovery | `src/queue/Submissions.ts` | Persisted submission jobs, publisher, worker, stale reconciliation, redrive | `src/queue/Submissions.ts` |
| Workflows | `SubmitAfterDelay`, `WaitForDeliveryEvent` | Durable delay and event waiting on `WorkflowEngine` | `src/workflow/Submissions.ts` |
| Gateway and SMTP | `Gateway`, `Catcher`, `Smtp` client/server | Authenticated submission paths with deny-by-default gateway/catcher authorization | `src/server/`, `src/smtp/` |
| Suppression | `SuppressionStore` | Admission-time check when a suppression store is present | `src/Suppression.ts` |
| Retention | `DeliveryStore.prune` | Prunes intents/events by time; does not yet model content/attempt/event retention separately | `src/DeliveryStore.ts` |

## Certainty model

| Errors | Certainty | Local retry | Worker behavior today |
| --- | --- | --- | --- |
| `DeliveryUncertain`, `MalformedProviderResponse` | `unknown` | Never | Records `uncertain`; no automatic resend or fallback |
| `ProviderRejected`, `AuthenticationFailed`, `IdempotencyConflict` | `rejected` | Only explicitly retryable rejections | Records `rejected`; retryable rejections defer while attempts remain |
| `InvalidMessage`, `UnsupportedCapability`, `TemplateError` | `not-submitted` | No | Stops immediately and records `failed` |
| `RateLimited`, `TransportUnavailable` | `not-submitted` | Yes, bounded and `Retry-After` aware | Defers when attempts remain |
| `StoreUnavailable`, `RecipientSuppressed`, `SubmissionCanceled` | `not-submitted` | No | Stops immediately and records `failed`; a failing store may prevent the write |

Sources: `src/EmailError.ts`, `src/RetryDecision.ts`, `src/EmailTransport.ts`,
`src/queue/Submissions.ts`.

Production provider HTTP request failures that occur before a response are
classified as `DeliveryUncertain` unless an adapter can prove the request was
not submitted. A received HTTP error status is still classified from that
status. Local Mailcrab and Mailpit catchers retain their development-oriented
transport failure behavior.

## Delivery lifecycle

`DeliveryStatus` values are `pending`, `in-progress`, `accepted`, `rejected`,
`uncertain`, `failed`, `canceled`, `delivered`, `bounced`, and `complained`.

```text
pending -> in-progress -> accepted -> delivered | bounced | complained
                       -> rejected
                       -> uncertain
                       -> failed
pending -> canceled
```

- `accepted` means the provider accepted responsibility for submission. It does
  not mean the recipient received the message.
- `in-progress` records that dispatching started. Process death during this
  state does not prove rejection.
- `uncertain` is terminal for automatic dispatch. Recovery requires provider
  lookup, verified events, or an explicit redrive with duplicate risk.
- `delivered`, `bounced`, and `complained` are projected from provider events.
  `opened` and `clicked` are stored but do not change delivery status.
- `dispatchGeneration` guards stale queue work and stale attempt completions.
- `claimId` and `claimExpiresAt` guard active attempts. A second worker cannot
  claim an in-progress delivery, and a stale claim cannot record an outcome.
- An expired claim requires reconciliation or explicit redrive; lease expiry does
  not authorize an automatic resend.

Sources: `src/DeliveryStore.ts`, `src/DeliveryStoreSql.ts`, `src/queue/Submissions.ts`.

## Current guarantees

- Admission commits an intent before returning an admission receipt.
- The outbox publisher can recover committed intents that were not yet queued.
- A provider-accepted message with a persistence failure is logged and the queue
  item is acknowledged to avoid an automatic duplicate submission.
- An uncertain result is never automatically retried or failed over.
- Policy wrappers and the durable worker use `src/RetryDecision.ts`; permanent
  local failures stop without consuming further queue attempts.
- Fallback revalidates the target and preserves original batch indexes.
- Native batch retry preserves accepted, uncertain, and invalid slots. Partial
  retry requires the provider to advertise `partialBatchRetry`.
- Original batch slots receive one normalized outcome each.
- Memory and SQL stores apply the same pure lifecycle transitions; SQL no longer
  restores or snapshots through a memory store.
- Concurrent identical intent creation returns one intent; different content
  returns `IdempotencyConflict`. SQL creation uses an atomic insert.
- Cancellation prevents future dispatch when the worker observes it; it cannot
  recall a submitted message.
- Suppression is enforced when a `SuppressionStore` is present.

## Known limits and gaps

| Gap | Current evidence | Consequence |
| --- | --- | --- |
| Tenant identity is optional in intents | `DeliveryIntent.tenantId` | Identity is not consistently part of durable lookup and correlation |
| Event wait uses the first stored event | `workflow/Submissions.ts` | An unrelated open/click event can satisfy the wait |
| Suppression discovery is optional | `SubmissionAdmission` uses `serviceOption` | A production assembly can accidentally omit enforcement |
| Background scans are unbounded | `listAll` and status scans | Publisher/reconciler work grows with total history |
| Registry routes are assembly-time | `Email.layerFromRegistry` | Route changes require rebuilding the layer |
| Storage schema is intent-oriented | migrations `0001`-`0004` | Attempt history and recipient-level outcomes are not first-class |
| No provider advertises partial batch retry yet | `partialBatchRetry` defaults to false | The safe subset-retry path is available to custom transports but is not used by shipped adapters |
| No production assembly example | `examples/` contains direct, provider, route, and deployment samples | Operators must infer worker, publisher, reconciler, and shutdown wiring |

These gaps are addressed by the workstreams and PR sequence in
`docs/service-improvement-plan.md`. They are not release blockers by themselves;
they become release gates when the reliability beta criteria are applied.
