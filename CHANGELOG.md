# Changelog

## Unreleased

- HTTP provider request failures before a response now surface as
  `DeliveryUncertain` and are not retried automatically.
- `withRetry` preserves native batch dispatch instead of silently falling back
  to per-message sends.
- `DeliveryStoreSql` uses transaction-local delivery state so concurrent
  operations on different deliveries cannot overwrite each other.
- Policy wrappers and the durable worker share retry decisions. Permanent local
  failures stop without consuming repeated queue attempts, while retryable
  rejections and rate limits honor their budgets and delays.
- Native batch retry preserves original indexes and never replays accepted or
  uncertain slots. Safe partial-subset retry is opt-in via
  `capabilities.partialBatchRetry`.
- Fallback revalidates the secondary transport before dispatch and uses the
  smaller composite batch/recipient limits.
- Added policy composition documentation and regressions for partial batch
  retry, fallback capability validation, and composite limits.
- Memory and SQL delivery stores now share pure lifecycle transitions. SQL
  transactions decode, transition, and persist one row without a memory-store
  restore/snapshot cycle.
- Added memory/SQL lifecycle parity coverage for deferred, accepted, delivered,
  redrive, and cancellation transitions.
- Attempts now acquire exclusive `claimId`/`claimExpiresAt` leases. A second
  worker cannot claim an in-progress delivery, and stale claims cannot record
  outcomes.
- SQL intent creation is atomic under concurrent insertion. Identical content
  returns the existing intent; different content returns `IdempotencyConflict`.
- Added concurrent create/claim coverage on SQLite and PostgreSQL.
- Delivery intents retain an embedded attempt history with claim IDs,
  timestamps, status, destination, receipt, and error details.
- SQL intents store and index `tenant_id`; `0005_delivery_tenant.sql` backfills
  existing PostgreSQL rows from stored JSON.
- Publisher and reconciler now use bounded delivery-ID pages for tenant outbox
  and stale-claim queries. `0006_delivery_query_indexes.sql` adds supporting
  indexes and the `claim_expires_at` column.
- Admission now uses the shared message preparation path, so invalid messages
  fail before a durable intent is created.
- Added `Routing.explain` for side-effect-free capability, requirement, and
  explicit-route diagnostics, plus `Routing` package export and docs.
- Provider events now carry ingestion time, provider/destination identity, and
  optional recipient/provider event IDs. Correlation uses receipt message IDs
  and destination, not caller-supplied delivery IDs alone.
- Event projection is deterministic: older events and contradictory terminal
  events are stored but cannot regress delivery status.
- `0007_event_correlation.sql` adds and backfills the provider message ID index.
- `WaitForDeliveryEvent` accepts explicit event types and re-checks stored events
  before blocking.
- The worker re-checks suppression immediately before dispatch.
- Cancellation returns `canceled-before-dispatch`, `cancellation-requested`, or
  `already-submitted`; uncertain redrive requires explicit duplicate-risk
  acknowledgment.
- Added a PostgreSQL durable-service example with admission, worker, publisher,
  reconciler, status lookup, and scoped shutdown.
- Added three adoption-level README guidance, a production assembly guide, and
  a delivery glossary.
- Added tenant/status paged operator queries and redrive actor/reason history.
- Documented retention boundaries and verified pruning keeps non-terminal work.
- Added a provider evidence matrix, Effect dependency strategy, and release
  qualification guidance.
- Added SMTP slow-client and invalid-command recovery coverage.
- Added `smoke:tarball` to build, pack, extract, verify exports, and import
  packaged root/provider/gateway/workflow/SMTP modules.
- Added bounded admission/attempt/acceptance/uncertainty/retry/failure metrics.
- Verified complaint events automatically suppress recipients when a suppression
  store is assembled; bounce suppression is opt-in.
- Added regressions for ambiguous HTTP failures, native batch retries, shared
  retry decisions, permanent worker failures, and concurrent PostgreSQL delivery
  transactions.

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
