# Driver parity

Upstream baseline: [productdevbook/unemail](https://github.com/productdevbook/unemail)
at `4d539b1590776fc68ab19653597f21f1b3ceb24b` (MIT, Copyright (c) 2025 Wind).

This port follows upstream's driver inventory and payload semantics, replacing
unemail's promise/middleware runtime with Effect services, typed errors, layers,
and `HttpClient`. Upstream remains the reference for provider-specific edge cases
and limits.

## Implemented

| Provider | Single | Native batch | Notes |
| --- | --- | --- | --- |
| Resend | yes | no | request-scoped idempotency, `Idempotency-Key` |
| Postmark | yes | yes | per-message `ErrorCode` on a `200` batch |
| SendGrid | yes | yes | `personalizations`, envelope grouping, duplicate-recipient splitting |
| Mailjet | yes | yes | `Messages` array, partial results on `400`, recipient split |
| MailerSend | yes | yes | `bulk-email` shares one id across the group; 50 recipients, 10 CC/BCC, 5 tags; retrieve falls back to bulk status |
| Brevo | yes | yes | `messageVersions`, envelope grouping, 2,000-recipient split, hashed batch idempotency; retrieve/cancel are scheduled-email endpoints and are not advertised |
| Mailgun | yes | yes | multipart form, `recipient-variables`, per-run shared id |
| SMTP | yes | no | MIME builder, DKIM, STARTTLS, AUTH PLAIN, raw MIME passthrough, pooled connections |
| SMTP2GO | yes | no | failure body on `200`, remote attachment URLs |
| Mailtrap | yes | yes | category required, sandbox/live hosts, per-request responses |
| Mailpit | yes | no | SMTP send, inbox list/get/last/find/delete/clear, raw and attachment bytes |
| Mailcrab | yes | no | SMTP send, inbox list/get/last/find/delete/clear, raw and attachment bytes |
| Scaleway | yes | no | 2 MB request cap, 10 recipients/attachments, explicit attachment content type, per-recipient email objects |
| SES | yes | no | SigV4, raw MIME, 50 recipients, 10 MiB raw cap, constrained tags, configuration set |
| Cloudflare Email | yes | no | legacy one-recipient raw MIME binding |
| Cloudflare Email Service (binding) | yes | no | structured 50-recipient binding, 32 attachments |
| ZeptoMail | yes | yes | address-count batching, `merge_info`, template endpoints |
| Azure Communication (HTTP) | yes | no | HMAC-SHA256, operation polling, sender/recipient payloads |
| AhaSend | yes | no | account-scoped routes, per-recipient results, idempotency replay |
| Loops | yes | no | template-only sends, idempotency keys capped at 100 chars |
| Cloudflare Email Service (REST) | yes | no | 50 recipients/32 attachments, per-recipient result sets |
| MailChannels | yes | yes | 1,000 personalizations/request, indexed results, campaign ids |
| Mailbreeze | yes | no | provider templates/ids, key-scoped test mode, 256-char idempotency |
| Tee | yes | no | explicit multi-receipt mirroring, optional sink recipient redirect |
| Generic HTTP | yes | no | caller-owned body, id extraction, failure classification |
| Mock | yes | yes | in-memory inbox, scripted failures, per-message latency |

Transport policies:

- `EmailTransport.withRetry` - retryable, known-not-submitted failures only;
  never retries uncertain submissions; honors `Retry-After`.
- `EmailTransport.withFallback` - per-slot failover, preserves accepted
  positions, refuses to fail over local validation/capability errors.
- `EmailTransport.withRoundRobin` - rotates new sends, pins retries to the
  first provider, and intersects capabilities.

## Next work

Provider coverage is complete against the pinned inventory. A Promise-based
`createEmail` facade exists; full middleware and upstream driver-object
compatibility remain separate migration work. Fallback, round-robin, and tee
mirroring are implemented.

## Contract gaps before full parity

Upstream messages carry structured tags (`name`/`value`), metadata, templates,
tracking, scheduling, sandbox, raw MIME, streams, cancellation, and retrieval.
This port models header-safe string tags, rendered and provider-template
sends, local template rendering, raw MIME, and optional retrieval/cancellation.
Structured tag objects, metadata, tracking, scheduling, sandbox fields, and
provider-native streams remain unimplemented. Adapting those drivers fully
requires extending `Message`, `SubmissionReceipt`, and `TransportCapabilities`
first rather than silently dropping fields.
