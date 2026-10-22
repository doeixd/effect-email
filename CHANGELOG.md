# Changelog

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
