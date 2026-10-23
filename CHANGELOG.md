# Changelog

## 0.3.0

This release combines the unreleased delivery-service work and correctness,
security, and performance fixes since the 0.2 series. Read the
[upgrade guide](./docs/upgrading-0.3.md) before restarting durable workloads.

### Added

- `Routing.explain` for capability and explicit-route diagnostics without sending.
- Typed assembly through `Email.layerValidated`, registry validation, and
  Cloudflare binding validation.
- `Service.start` for scoped publisher, worker, and reconciler loops with health
  and shutdown handles; custom queues are consumed directly with their policy.
- Exclusive attempt claims, embedded attempt history, tenant/status paging,
  redrive audit, grouped diagnostics, and admission/delivery metrics.
- `Submissions.reconcileUncertain` for provider lookup, including deliveries
  without an acceptance receipt.
- Durable typed and purpose-specific workflow event subscriptions, backed by
  memory and SQL delivery stores; webhook replay retries missed notifications.
- PostgreSQL migrations through `0008_delivery_event_waits.sql`, a runnable
  durable-service example, and production, operations, and policy guides.
- SMTP client connection, command, and cleanup deadlines.

### Changed

- Pin Effect and matching runtime, SQL, and test packages to stable `4.0.6`.
- Require Node 22.19.0 or newer for Node bindings, matching the HTTP runtime dependency.
- Use versioned, unambiguous workflow identities. Persisted executions must be
  drained or explicitly migrated before new submissions use the new keys.
- Require canonical event lookup (`getEvent`) and event-wait registration,
  removal, and listing in custom delivery stores.
- Reschedule deferred delivery jobs using queue visibility delays, preserving
  provider-attempt budgets and backoff without occupying workers.
- Generate stable batch/stream provider keys and delivery IDs on replay. Keep
  message order, and stream chunk size, unchanged for a given idempotency key.
- Reject redrive while a provider attempt is active. Uncertain redrive still
  requires explicit duplicate-risk acknowledgment.

### Fixed

- Fence suppression outcomes with the worker's acquired attempt claim, preventing
  duplicate workers from overwriting an active provider submission.
- Serialize PostgreSQL admission, cancellation, and lifecycle updates even before
  an intent exists; an acknowledged cancellation cannot race past creation.
- Treat conflicting native batch indexes as uncertain before retry decisions,
  preventing accepted messages from being submitted again.
- Preserve arbitrary JSON template data, metadata, and event payloads through SQL
  storage, including objects resembling internal serialization markers.
- Return retryable webhook failures when suppression or workflow notification
  fails; replay retries follow-up work using the canonical stored event.
- Rotate provider idempotency keys for redrive while keeping retries within the
  new dispatch stable, and reject replay with changed SMTP envelope addresses.
- Encode MIME leaf parts without incorrectly marking multipart containers as
  base64 content.
- Treat ambiguous HTTP submission failures as uncertain; never automatically
  retry or fail over a submission whose acceptance is unknown.
- Preserve native batch operations through retry decorators. Keep accepted and
  uncertain slots out of retries; safe partial retry remains opt-in.
- Preserve completed rate-limit chunks after later failure, and normalize
  fallback outcomes by declared indexes on both legs.
- Count actual SMTP envelope recipients in quota/capability checks and record
  retryable native-batch row failures in circuit-breaker health.
- Share lifecycle transitions between memory and SQL stores; use transaction-local
  locked rows for concurrent intent creation, claims, and outcome updates.
- Preserve active claims during queue publication and check cancellation
  atomically before acquiring an attempt.
- Reject delivery-ID reuse across tenants and prevent cross-tenant workflow-key
  collisions and cached-result reuse.
- Match provider events against destination/account, provider message ID, and
  dispatch generation; retain miscorrelated events without treating them as
  delivery evidence or workflow completion.
- Reconcile expired claims despite non-resolving events, and keep scoped
  complaint suppression from affecting another account's recipients.
- Reject delivery-ID MIME header injection, preserve null SMTP reverse paths,
  and redirect explicit envelope recipients when teeing to a sink.
- Close SMTP sessions after overlong commands; bound discarded DATA buffers and
  parse incoming DATA in linear time without per-byte output allocations.
- Produce verifiable DKIM signatures with correct header ordering, duplicate
  header selection, relaxed body handling, and binary MIME preservation.
- Preserve confirmed SMTP acceptance without waiting for reset/quit replies;
  bound cleanup and discard interrupted pooled sessions.
- Apply one stream concurrency limit across chunks and native requests.
- Keep terminal retention behavior consistent across memory and SQL stores.

## 0.2.1

- SMTP `authenticate` can return a typed principal, and `admit` receives the
  authenticated principal, authentication state, and TLS state.
- Excess SMTP connections receive a `421 Too many connections` response.
- Documented that the SMTP server is a submission gateway, not a full MTA.
- Clarified that README snippets are fragments and linked complete examples.

## 0.2.0

- Added `TransportRegistry` for route-keyed transports and
  `Email.layerFromRegistry` / `Email.layerFromRegistryLayer`.
- Added provider client/transport layer sharing tests and provider surface
  conformance checks.
- Added multi-route and provider-layer examples.
- Updated README, runtime matrix, driver parity notes, release checklist, and
  the transport/provider improvement plan.
- Added the alchemy.run Cloudflare Worker deployment example.
- Includes the 0.1.0 release baseline.

## 0.1.0

Initial release.

- Effect v4 core message, transport, policy, batch, stream, template, spool,
  suppression, delivery-store, queue, workflow, gateway, catcher, and SMTP
  modules.
- 24 provider/infrastructure adapters, including local catchers and Mock.
- Durable delivery intents, SQL delivery store, queue/outbox recovery,
  cancellation tombstones, retention, and stale-work reconciliation.
- HTTP gateway with deny-by-default authorization, provider-event verification,
  request limits, diagnostics, and workflow resumption.
- SMTP client/server with MIME, DKIM, STARTTLS, AUTH PLAIN, pooling, and
  configurable resource limits.
- PostgreSQL migrations and a PostgreSQL-backed CI workflow.
- Full review findings and residual risks in `docs/review-findings.md`.
