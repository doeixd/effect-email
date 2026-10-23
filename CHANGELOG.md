# Changelog

## Unreleased

- HTTP provider request failures before a response now surface as
  `DeliveryUncertain` and are not retried automatically.
- `withRetry` preserves native batch dispatch instead of silently falling back
  to per-message sends.
- `DeliveryStoreSql` uses transaction-local delivery state so concurrent
  operations on different deliveries cannot overwrite each other.
- Added regressions for ambiguous HTTP failures, native batch retries, and
  concurrent PostgreSQL delivery transactions.

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
