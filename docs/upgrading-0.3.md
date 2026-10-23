# Upgrading from 0.2.x to 0.3.0

0.3.0 includes durable-delivery API changes and fixes for replay, tenant
isolation, event correlation, and SMTP resource handling. Back up delivery,
queue, workflow-engine, and suppression state before the upgrade. External
delivery remains at least once or uncertain; no local transaction can make a
provider send exactly once.

## Upgrade order

1. Stop new admissions and let active provider attempts finish. Reconcile
   interrupted or expired claims; lease expiry does not prove non-delivery.
2. Drain existing workflows, or explicitly migrate their persisted executions
   and completion tokens using the workflow engine's migration process. Keep
   the old deployment available until old executions are accounted for.
3. Apply the missing SQL migrations in order, through
   [`0008_delivery_event_waits.sql`](../migrations/0008_delivery_event_waits.sql).
   See [PostgreSQL deployment](./postgres.md) for column backfills on older stores.
4. Use Node 22.19.0 or newer for Node bindings. Install
   `@doeixd/effect-email@0.3.0` and align the application's Effect
   dependencies with the exact `4.0.6` versions used by this release. Verify
   that the application resolves one Effect runtime.
5. Update custom store implementations and worker adapters as described below.
6. Start the workflow engine, admission, worker, publisher, and reconciler layers;
   verify a controlled submission, status lookup, cancellation, and provider event.

## Workflow identities and waits

Workflow keys now encode tenant, delivery, filter, purpose, and optional
generation as structured, versioned data. This prevents separator collisions
and separates type filters even when their purpose is the same. **New execution
IDs differ from 0.2.x IDs.** Resubmitting an old payload creates a new execution;
it is not a migration and can send mail again.

Typed and purpose-specific waits register subscriptions in the delivery store.
The gateway requires the workflow-engine service in its request context to
notify those subscriptions. It retries notifications on verified webhook replay,
using the canonical stored event rather than a replacement body under the same ID.

Persisted wait subscriptions are included in delivery-store snapshots. Use
`interruptDeliveryEventWait` with both the engine and delivery store in context
to remove interrupted subscriptions. Directly interrupting an engine execution
does not perform this store cleanup.

## Custom delivery stores

Implement these additional `DeliveryStoreShape` operations:

| Operation | Required behavior |
| --- | --- |
| `getEvent(id)` | Return the canonical stored event by its globally unique ID, or `Option.none()`; replay must preserve its original body. |
| `registerEventWait(wait)` | Persist once by execution ID; repeated registration preserves the original subscription. |
| `removeEventWait(executionId)` | Idempotently remove the subscription. |
| `listEventWaits(deliveryId)` | Return subscriptions for that delivery, including their tenant, type filter, and generation. |

Snapshots may include `eventWaits`; restore must preserve them and accept older
snapshots that omit the field. The built-in SQL layer creates the wait table and
delivery index idempotently. Explicit production provisioning should apply
migration `0008` before the new runtime starts.

`findByProviderMessageId` now accepts optional provider and destination filters.
Apply them **before** choosing the newest receipt. Provider message IDs are not
assumed globally unique across accounts. Admission exposes `getEvent` and
`listEventWaits` as part of its service shape; custom admission implementations
must forward both operations.

Delivery fingerprints include the SMTP envelope sender and recipients. Reusing
a delivery ID with a changed envelope now fails with `IdempotencyConflict`.
The built-in stores compare older fingerprints against their persisted message
and envelope, so existing intents do not require a fingerprint backfill.

## Worker and retry adapters

Use the supplied queue directly:

```ts
const handle = yield* Service.start({
  queue: admission.queue,
  tenantId,
  workerConcurrency: 2
})
```

`ServiceOptions.queueName` is deprecated. `Submissions.runWorker({ queue })`
inherits the supplied queue's attempt budget and retry schedule; explicit
worker options can override them.

`processSubmission` no longer sleeps until `nextAttemptAt`. It returns a
`RateLimited` error containing the remaining delay. The built-in worker offers
a delayed retry before acknowledging the current job. Custom consumers must
implement equivalent scheduling, keep original outcomes, and preserve the
delivery's provider-attempt budget across retry queue items. Prefer the built-in
worker rather than passing `processSubmission` directly to a custom take loop.

## Batch and stream replay

For one `providerIdempotencyKey`, replay the same messages in the same order.
For streams, also preserve `chunkSize`. Generated delivery IDs and per-message
provider keys are now stable for those slots; their exact key format has changed.
Explicit message delivery IDs still take precedence.

Retry and fallback retain accepted and uncertain outcomes. Native subset retry
still requires `capabilities.partialBatchRetry: true`. Rate-limit chunking
preserves earlier successes when a later chunk fails. Circuit breakers observe
retryable row failures even when the provider returns a valid outcome array.

## Events, cancellation, and redrive

- Supply provider, destination/account, and provider message ID for receipt
  correlation. Without an explicit delivery ID, a destination is required.
- After redrive, supply the current provider message ID or dispatch generation.
  Bare delivery-ID events cannot identify the attempt safely.
- Misidentified events remain in audit history but cannot project delivery state
  or satisfy a wait for an existing intent.
- Cancellation is checked when a claim is acquired. Cancellation after a claim
  is acquired remains a request and cannot recall a submitted message.
- Active in-progress deliveries reject redrive, even with risk acknowledgment.
  Reconcile first. Uncertain redrive still needs `acknowledgeDuplicateRisk: true`.
- Each redrive persists a new provider idempotency key, including when admission
  supplied a custom key. Retries within that generation reuse the new key.

The gateway returns HTTP 503 if complaint suppression or workflow notification
fails after event ingestion. Configure webhook senders to retry these responses.
Replay deduplicates event storage and retries follow-up work using the original
stored event. Custom admission adapters must propagate suppression failures.
Suppression implementations should make repeated writes for the same recipient
safe; a replay may repeat writes that succeeded before another write failed.

## SMTP

| Option | Default | Purpose |
| --- | --- | --- |
| `connectTimeoutMillis` | 10,000 | Bound connection setup. |
| `commandTimeoutMillis` | 30,000 | Bound command/reply I/O, TLS upgrade, and DATA writes. |
| `cleanupTimeoutMillis` | 100 | Bound best-effort QUIT writing; no QUIT reply is required. |

Confirmed DATA acceptance returns without an extra RSET exchange. Interrupted
pooled sessions are discarded. A timeout after DATA may be uncertain and is not
automatically retried. Overlong command lines close the server session after one
error reply. Explicit SMTP envelope recipients determine quotas and capability
limits, and tee sinks redirect those envelope recipients as well as message
recipients.

## Upgrade verification

Run the application's tests with its actual SQL and workflow engine, then
exercise custom routes, suppression, event-signature verification, and shutdown.
The package's [release checklist](./release.md) records its validation scope;
provider contract fixtures do not establish live-provider sandbox compatibility.
