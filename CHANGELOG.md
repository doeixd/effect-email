# Changelog

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
