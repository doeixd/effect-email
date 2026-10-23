# Operations

## Tenant-scoped delivery queries

Use `SubmissionAdmission.listForTenant` for bounded operator lookups:

```ts
const page = yield* admission.listForTenant({
  tenantId,
  status: "uncertain",
  limit: 50,
  after: previousDeliveryId
})
```

Results are ordered by delivery ID and include status, attempts, claim state,
receipt, errors, provider events, and redrive history. `listAll` and the legacy
status accessors remain for compatibility, but background work uses bounded
queries. The HTTP `GET /deliveries` route accepts `tenantId`, `limit`, and
`after` for bounded operator pages; without `tenantId` it retains the legacy
unscoped listing.

## Redrive audit

Redrive an uncertain delivery only after acknowledging duplicate risk:

```ts
yield* admission.redrive(deliveryId, {
  acknowledgeDuplicateRisk: true,
  actor: "operator@example.com",
  reason: "provider confirmed non-delivery"
})
```

The HTTP gateway accepts the same information through
`x-effect-email-acknowledge-duplicate-risk: true`,
`x-effect-email-redrive-actor`, and `x-effect-email-redrive-reason`.

The intent retains `redriveHistory` with the previous generation, timestamp,
actor, and reason.

Redrive also persists a fresh provider idempotency key. Retry jobs within that
dispatch reuse it; the prior dispatch's provider response cannot deduplicate a
new redrive. This also replaces any caller-supplied key from admission.

An in-progress delivery rejects redrive, including when duplicate risk is
acknowledged. Reconcile it first. Advancing a generation does not cancel a
provider call that is still running.

## Retention

`DeliveryStore.prune` removes only terminal intents and old events. Pending,
in-progress, accepted, and uncertain intents remain available. Old rejected,
failed, canceled, delivered, bounced, and complained intents are eligible.

- Content and receipt references follow the intent lifecycle.
- Provider events are pruned by occurrence time.
- Cancellation tombstones are not pruned by `prune`.
- Attempt and redrive history is embedded in the intent JSON and is removed with
  the intent.
- Remote attachment URLs are references, not content snapshots. Do not prune
  source content until the replay window closes.

Define separate retention windows for content, events, idempotency metadata,
cancellation tombstones, and audit history before production use.

## Provider lookup reconciliation

Use `Submissions.reconcileUncertain` with a lookup function when the provider
supports meaningful receipt lookup:

```ts
const reconciled = yield* Submissions.reconcileUncertain({
  lookup: (intent) =>
    intent.receipt === undefined
      ? Effect.succeed(Option.none())
      : Email.retrieve(intent.receipt).pipe(
          Effect.map((status) =>
            Submissions.deliveryStatusEvent(intent, status, now)
          )
        )
})
```

The example maps receipt-based retrieval to delivered/bounced/complained events.
The helper also calls `lookup` for receipt-less uncertainty. Implement that
branch using a provider-supported lookup by `intent.providerIdempotencyKey` or
`intent.deliveryId` when available; returning `Option.none()` leaves it unresolved.
Lookup results are bound to the generation being reconciled. Failure does not
authorize a resend, and providers without a usable lookup may require operator
reconciliation.

## Provider events and workflow waits

Include provider, destination/account, and provider message ID when correlating
events. Provider message IDs are not assumed unique across accounts. Events
that do not match the current receipt or generation remain in audit history but
cannot resolve a workflow wait or project delivery status.

Typed and purpose-specific waits register in the delivery store. Provide the
workflow engine to the gateway to wake matching waits. Webhook retries use the
stored canonical event and retry notifications even when ingestion deduplicates
the event. Use `interruptDeliveryEventWait` with the engine and delivery store
in context to remove interrupted subscriptions.

Failures during suppression or workflow notification return HTTP 503, even if
the event was already stored. Configure webhook retries for those responses.
Replays use `getEvent(id)` to retry follow-up work from the canonical event;
changing the replay body cannot change suppression targets or event types.
Suppression writes may repeat after a partial failure and must be idempotent.

## Diagnostics and tracing

Admission, worker, and provider operations carry Effect span annotations for
delivery ID, route, provider, and queue attempt.

Metrics exported by `src/Metrics.ts`:

- `effect_email_admissions_total`
- `effect_email_attempts_total`
- `effect_email_accepted_total`
- `effect_email_rejected_total`
- `effect_email_uncertain_total`
- `effect_email_retries_total`
- `effect_email_failures_total`

Keep high-cardinality values such as delivery IDs and recipient addresses in
traces, not metric labels. Provider payloads, credentials, and attachments must
not be logged by default.

## Readiness

See [`production-assembly.md`](./production-assembly.md). Readiness requires SQL,
queue, admission, and email layers plus started worker/publisher/reconciler
fibers. Shutdown stops admissions before interrupting loops.
