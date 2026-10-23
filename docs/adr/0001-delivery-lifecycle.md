# ADR 0001: Delivery lifecycle, certainty, and ownership

- Status: Accepted for implementation
- Date: 2026-10-22
- Baseline: `4bf13f96ff90d521be87a1441b15a7ef555db387`
- Related: `docs/baseline-inventory.md`, `docs/service-improvement-plan.md`

## Context

effect-email exposes direct transport values, Effect services and layers,
destination-aware receipts, typed submission errors, durable delivery intents,
and optional queue, workflow, gateway, and SMTP integrations. Those pieces work,
but the boundary between admission, submission, provider acceptance, and
recipient delivery is not stated as a single contract.

Without an explicit lifecycle, three failure classes are easy to conflate:

1. A durable intent exists but has not been published or dispatched.
2. A provider may have accepted a message, but the response was lost.
3. A provider accepted a message, but final recipient delivery is still unknown.

The lifecycle must keep those states distinct. It must also prevent a local
retry or fallback policy from turning an unknown outcome into a duplicate send.

## Decision

### 1. Acknowledgment boundaries

- `SubmissionAdmission.accept` succeeds only after the intent is durably
  committed. A queue publication failure after commit is recoverable and must
  not erase the admission.
- Queue publication is not the durable boundary. The committed intent is.
- Provider acceptance is not recipient delivery. An accepted receipt records
  destination, provider, provider message ID when available, and acceptance time.
- Acknowledging an SMTP or HTTP submission transfers durable responsibility to
  the service. Downstream uncertainty must remain visible; it must not be
  reported as delivery success.

### 2. Ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Message preparation | Normalization, validation, rendering, requirements | Network submission or durable scheduling |
| Transport | One provider submission attempt and its outcome | Business scheduling or global lifecycle |
| Transport policy | Explicit local retry, fallback, throttling, circuit state | Hidden durable resubmission |
| Email | Preparation, route selection, dispatch, normalized outcomes | Mandatory SQL, queue, or workflow setup |
| SubmissionAdmission | Authorization, admission snapshot, durable intent | A claim that provider acceptance occurred |
| DeliveryStore | Lifecycle state, attempts, events, concurrency guards | Provider network calls inside SQL transactions |
| Queue worker | Claim and dispatch eligible attempts, record outcomes | Business-process orchestration |
| Workflow | Business delays, event predicates, coordination | A second independent provider retry loop |
| Gateway/SMTP | Authentication, tenant context, admission invocation | A parallel delivery implementation |

Keep `Transport` a value. Keep provider `Client` services where native
functionality warrants them. Keep static routes as the default; registry routes
are an assembly mechanism, not a hot-reconfiguration system.

### 3. Certainty and retry

- `not-submitted` means the submission provably did not occur. It does not mean
  the error is worth retrying.
- `rejected` means the provider or a local authority definitively refused the
  submission.
- `unknown` means acceptance may have occurred. It includes connection loss or
  timeout after possible transmission, malformed success responses, and provider
  ambiguity.
- An unknown outcome is never automatically retried, failed over, or redriven.
- Retry eligibility is separate from certainty. Permanent local failures must
  terminate without consuming repeated worker attempts.
- A definite transient failure may be retried within an explicit budget.
- `Retry-After` is honored. Exhaustion is recorded and observable.
- Durable workers own delayed retries by default. Short transport retries are
  opt-in and count toward a documented total attempt budget.
- Provider-idempotent replay is allowed only with the same destination/account,
  key, payload fingerprint, and a verified provider deduplication window. That
  permission never crosses fallback or a different destination.

The shared decision function belongs in implementation, not in each adapter or
worker branch. Its inputs are the error, attempt budget, retry-after, destination,
and replay context; its outputs are stop, retry later, or reconcile uncertainty.

### 4. State model

Admission and submission state:

```text
pending -> in-progress -> accepted
                       -> rejected
                       -> uncertain
                       -> failed
pending -> canceled
```

Recipient outcome state:

```text
accepted -> delivered | bounced | complained
```

Rules:

- `accepted` means provider responsibility, not delivery.
- `uncertain` stops automatic dispatch. It requires reconciliation, verified
  events, or an explicit redrive.
- `opened` and `clicked` are historical events and do not project a delivery
  status.
- `dispatchGeneration` prevents stale queue work from completing current work.
- Attempt results compare the expected generation. Late results must not
  overwrite a newer generation.

### 5. Claims and transactions

- Do not hold a SQL transaction open during provider I/O.
- Begin an attempt by acquiring an exclusive claim. The target model includes a
  claim ID, generation, lease/expiry metadata, and expected state or revision.
- Lease expiry does not prove the provider call failed. Expired in-progress work
  becomes uncertain or remains pending reconciliation; it must not authorize a
  blind resend.
- `createIntent` must be atomic under concurrent insertion. A uniqueness
  conflict fetches the existing intent and compares its fingerprint, returning
  the existing intent or `IdempotencyConflict` without overwriting it.
- Tenant and delivery identity participate in durable identity, authorization,
  lookup, and event correlation. Composite tenant/delivery keys are the target;
  tenantless legacy rows need an explicit migration policy.

### 6. Events, cancellation, and retention

- Store provider occurrence time and local ingestion time.
- Normalize event identity with provider, account/destination, and provider
  event ID; deduplicate atomically.
- Resolve tenant and delivery through verified receipt correlation. Do not trust
  a caller-supplied delivery ID alone.
- Duplicate and out-of-order events must not regress state arbitrarily.
  Contradictory evidence remains in history.
- Event waits match explicit event types and scope. A first-event shortcut is
  not sufficient.
- Cancellation prevents future dispatch where possible and reports whether
  dispatch could be prevented. It cannot recall a submitted message.
- Redrive requires an explicit duplicate-risk acknowledgment in the audit trail.
- Retention is defined separately for content, attempts, provider events,
  idempotency metadata, cancellation tombstones, and audit history. Content
  referenced by queued or active work must remain available.

### 7. Persistence and recovery

- Admission snapshots rendered content, attachment references/checksums, and
  envelope data needed for replay.
- Durable queued work does not refetch arbitrary mutable URLs.
- A crash after intent commit but before queue publication is recovered by the
  publisher.
- A crash after provider acceptance but before persistence is reconciled as
  uncertain or unresolved work, never as an automatic replay.
- Restart recovery does not imply exactly-once external delivery.
- Schema and queue migrations are explicit, dialect-aware, and have a documented
  rollback boundary. `CREATE TABLE IF NOT EXISTS` is not an upgrade strategy.

## Invariants

1. Provider acceptance, admission, and recipient delivery are distinct.
2. Unknown outcomes are not automatically retried or failed over.
3. Advertised capabilities correspond to available, semantically correct
   operations.
4. Every original batch slot has exactly one normalized outcome with its
   original index.
5. Tenant context participates in identity and event correlation.
6. At most one active claim exists for an attempt.
7. Cancellation cannot promise recall of a submitted message.
8. Replay preserves rendered content, attachment identity, and envelope data.
9. Duplicate and late events cannot arbitrarily regress state.
10. Retention never removes content still needed by active or queued work.

## Consequences

- More HTTP failures will be reported as `DeliveryUncertain` rather than
  retryable. This is a deliberate safety tradeoff.
- Existing queue workers that retry every `not-submitted` error must adopt the
  shared retry decision before the reliability beta.
- The delivery schema needs attempt and claim metadata before multi-worker
  deployment can be considered fully safe.
- Documentation must describe direct, resilient, and durable adoption separately.
- No claim of universal exactly-once delivery is permitted.

## Implementation sequence

1. Shared retry decisions and adapter certainty audit.
2. Native-batch policy preservation and composition contract tests.
3. Pure lifecycle transitions and transaction-local SQL execution.
4. Atomic claims, creation, and tenant identity migration.
5. Outbox/reconciler queries and attempt history.
6. Shared preparation and route diagnostics.
7. Correlated events, event predicates, cancellation, and suppression.
8. Production assembly, operator queries, and release gates.

The detailed acceptance criteria live in `docs/service-improvement-plan.md`.
