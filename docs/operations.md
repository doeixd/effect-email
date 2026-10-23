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
queries.

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

## Retention

`DeliveryStore.prune` removes only terminal intents and old events. Pending,
in-progress, accepted, uncertain, and delivered intents remain available.

- Content and receipt references follow the intent lifecycle.
- Provider events are pruned by occurrence time.
- Cancellation tombstones are not pruned by `prune`.
- Attempt and redrive history is embedded in the intent JSON and is removed with
  the intent.
- Remote attachment URLs are references, not content snapshots. Do not prune
  source content until the replay window closes.

Define separate retention windows for content, events, idempotency metadata,
cancellation tombstones, and audit history before production use.

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
