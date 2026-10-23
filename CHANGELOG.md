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
