# effect-email review findings

Started: 2026-10-22

## Snapshot

Baseline before review:

- `bun run typecheck`: pass.
- `bun run test`: 214 passed, 1 skipped, 53 test files passed, 54 discovered.
- Benchmark: `bun bench/send.ts` = 20,000 accepted in 1,358 ms (14,731/s).
- Dependencies: one `effect@4.0.0-rc.118`, one
  `@effect/platform-node-shared@4.0.0-rc.118`.
- PostgreSQL integration test not run in the initial baseline; previously
  verified against PostgreSQL 16.

Current snapshot after review fixes:

- `bun run typecheck`: pass.
- `bun run test`: 244 passed, 1 skipped, 53 test files passed, 54 discovered.
- Benchmark after warmup: 20,000 accepted in 1,349 ms (14,821/s).
- Thirty-one regression tests were added across forty-six focused fixes.
- No open Critical/High blockers remain; residual release constraints are listed
  below.

Follow-up snapshot (`1b8f168`, 0.4.0):

- `bun run check`: 305 passed across 60 files, including PostgreSQL 17
  integration.
- Dependencies: `effect@4.0.6` and matching stable `@effect/*` packages.
- Ambiguous HTTP request failures now surface as `DeliveryUncertain`.
- Native batch dispatch survives `withRetry`.
- Policy wrappers and the durable worker share retry decisions; permanent local
  failures stop without repeated attempts.
- Native batch retry preserves indexes and never replays accepted or uncertain
  slots; fallback revalidates its target and uses safe composite limits.
- Memory and SQL delivery stores share pure lifecycle transitions, with parity
  coverage for deferred, accepted, event-projected, redrive, and cancellation paths.
- Attempts acquire exclusive claims with lease metadata. Concurrent intent
  creation and claim races are covered on SQLite and PostgreSQL.
- Intents retain embedded attempt history, and SQL stores/indexes `tenant_id`
  with a PostgreSQL backfill migration.
- Publisher and reconciler use bounded delivery-ID pages for tenant outbox and
  stale-claim queries; supporting indexes are added by migration `0006`.
- Admission uses the shared `Message.prepare` path, and `Routing.explain`
  reports capability and explicit-route diagnostics without sending.
- Provider events correlate by receipt message ID/destination and project
  deterministically; older or contradictory events cannot regress terminal state.
- Typed event waits re-check stored history; dispatch re-checks suppression;
  cancellation returns explicit outcomes and uncertain redrive requires
  duplicate-risk acknowledgment.
- Added a runnable PostgreSQL service assembly and adoption-level documentation.
- Added tenant/status delivery paging, redrive actor/reason history, and retention
  safety coverage.
- Added provider evidence labeling, dependency strategy, and SMTP slow-client /
  invalid-command coverage.
- Added bounded admission and worker counters for operational metrics.
- Complaint events automatically update suppression when a store is assembled.
- Added paged provider-lookup reconciliation for uncertain deliveries.
- Gateway diagnostics/health use grouped status summaries.
- Added `Email.layerValidated` for typed assembly failures and `Service.start`
  for scoped worker health/shutdown.
- SQL delivery transitions use transaction-local state; concurrent delivery
  isolation is tested.
- The current inventory and remaining gaps are in `docs/baseline-inventory.md`.

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Baseline and inventory | Complete | Commands and package surface checked |
| Phase 0 package/dependency review | Complete | Package, exports, deps, index, runtime entrypoint and docs checked |
| Phase 1 core contracts | Complete | Ids, Message, EmailError, Submission, EmailTransport, Email, RecordingTransport, Template reviewed |
| Phase 1 tests | Complete | Email, Message, Batch, NativeBatch, Stream, Policy, Template tests reviewed |
| Phase 2 policies | Complete | Retry, fallback, rate limit, circuit breaker, round-robin, tee reviewed |
| Phase 4 store/queue/SQL | Complete | Delivery lifecycle, SQL locking, outbox, retention, suppression reviewed |
| Phase 6 HTTP | Partial | Gateway auth hook, body limit, Catcher reviewed |
| Phase 6 SMTP | Complete | Session, Node server, MIME, DKIM, SMTP client reviewed |
| Phase 3 providers | Complete | All 24 adapters reviewed in three batches; fixes and residuals below |
| Phase 8 tests/docs/bench | Complete | Three stable suite runs, warmed benchmark, parity/runtime docs audited |

## Fixed findings

### RF-01: Batch provider idempotency key was reused for every message

Severity: High

Files:

- `src/Email.ts`
- `test/Batch.test.ts`

Evidence:

`Email.sendBatch` passed `BatchOptions.providerIdempotencyKey` unchanged into
every prepared envelope. For non-native transports, a batch of N messages could
therefore submit the same provider idempotency key N times. Providers that
deduplicate by that key can suppress all but one message.

Fix:

- Non-native batch dispatch now derives
  `${providerIdempotencyKey}:${deliveryId}` per message.
- Native batch transports keep the original BatchOptions key so provider-level
  batch idempotency semantics (for example Brevo) are unchanged.
- Added a regression test asserting per-message uniqueness and the required
  prefix.

Status: Fixed and tested.

### RF-02: Interrupted half-open circuit probe could wedge the breaker open

Severity: High

Files:

- `src/EmailTransport.ts`
- `test/Policy.test.ts`

Evidence:

`withCircuitBreaker` set `probeInFlight: true` when entering half-open. The flag
was cleared only after a successful or failed operation result. If the probing
fiber was interrupted or died with a defect, the flag stayed true and every
later call was rejected with `TransportUnavailable` and `retryAfterMillis: 0`.

Fix:

- Added `releaseProbe` and wrapped the probe result in `Effect.ensuring`, so the
  flag is cleared on interruption and defects.
- Added a regression test that interrupts an in-flight probe and proves the next
  call is allowed.

Status: Fixed and tested.

### RF-03: Destination IDs could collide across provider/account boundaries

Severity: Medium

Files:

- `src/Ids.ts`
- `test/Email.test.ts`

Evidence:

Destination IDs were built as `${provider}:${account}` without escaping.
`{ provider: "a:b", account: "c" }` and
`{ provider: "a", account: "b:c" }` produced the same ID. Receipt routing,
rate-limit keys, and transport selection rely on this ID.

Fix:

- Both components are now `encodeURIComponent`-escaped before concatenation.
- Normal IDs such as `mock:default` remain unchanged.
- Added a collision regression test.

Status: Fixed and tested.

### RF-04: Native batch receipts could miss delivery metadata

Severity: Medium

Files:

- `src/Email.ts`
- `test/NativeBatch.test.ts`

Evidence:

Per-message sends finalized receipts with the envelope's delivery ID, route, and
destination. Native batch accepted outcomes were passed through unchanged. A
provider adapter that returned a receipt without optional delivery metadata
produced an inconsistent public batch outcome.

Fix:

- Native batch accepted outcomes now run through `finalizeReceipt` with the
  corresponding envelope.
- Added a regression test for a provider receipt without delivery ID or route.

Status: Fixed and tested.

### RF-05: HTML-to-text could throw on out-of-range numeric entities

Severity: Medium

Files:

- `src/render/Template.ts`
- `test/Template.test.ts`

Evidence:

`defaultHtmlToText` called `String.fromCodePoint(code)` for numeric entities
without checking the Unicode range. Input such as `&#x110000;` throws
`RangeError` during text fallback, turning a render path into a defect.

Fix:

- Numeric entities are decoded only when the code point is an integer in
  `0..0x10FFFF`; otherwise the original entity is preserved.
- Added a no-throw regression test.

Status: Fixed and tested.

### RF-06: Oversized rate-limit token requests bypassed the limit

Severity: Medium

Files:

- `src/EmailTransport.ts`
- `test/Policy.test.ts`

Evidence:

`withRateLimit` charges `recipients` and `messages` using the full envelope or
chunk. `RateLimiter.sleep` does not reject a token request larger than the
configured limit; it returns a one-window delay and allows the operation. A
single message with more recipients than the configured recipient window could
therefore proceed without ever fitting the limit.

Fix:

- A token request larger than its configured window now fails with
  `UnsupportedCapability` and capability `rate-limit:<name>` before contacting
  the limiter or provider.
- Added a regression test for a message larger than the recipient window.

Status: Fixed and tested.

### RF-07: Fallback capability advertisement was over-conservative

Severity: Low

Files:

- `src/EmailTransport.ts`
- `test/Policy.test.ts`

Evidence:

`withFallback` advertised `retrieve` and `cancel` only when both legs supported
them. Receipt-routed operations can still support a capability when only the
leg that produced the receipt supports it.

Fix:

- Fallback now advertises `retrieve`/`cancel` when either leg supports them.
- Added a capability regression test.

Status: Fixed and tested.
### RF-14: Outbox publisher crossed tenant boundaries

Severity: High

Files:

- `src/queue/Submissions.ts`
- `test/Queue.test.ts`

Evidence:

`publishPending(queue, tenantId)` read `DeliveryStore.listUnqueued`, which is not
tenant-scoped, and offered every pending intent using the publisher's tenant.
A publisher for tenant A could publish tenant B's work under tenant A's queue
identity.

Fix:

- `publishPending` now filters intents by the requested tenant before offering.
- Existing publisher tests create tenant-scoped intents.
- Added a regression test proving another tenant's intent remains unqueued.

Status: Fixed and tested.

### RF-15: Provider acceptance could be lost and then retried as a duplicate

Severity: High

Files:

- `src/queue/Submissions.ts`
- `test/Queue.test.ts`

Evidence:

After a provider accepted a message, `processSubmission` persisted the receipt
with `recordAccepted`. If that store call failed, the whole queue attempt failed.
PersistedQueue would then retry the job, potentially submitting the message a
second time even though the provider had already accepted it.

Fix:

- `recordAccepted` failure is caught and logged.
- The queue item is acknowledged to prevent duplicate submission.
- Added a regression test using an accepted provider and a store whose
  `recordAccepted` always fails.

Status: Fixed and tested. The delivery intent remains `in-progress` when this
path occurs, so reconciliation against provider events/retrieval is still
required. This is tracked as an operational risk below.

### RF-16: SQL intent mutations could lose updates without a row lock

Severity: High

Files:

- `src/DeliveryStoreSql.ts`
- `test/Postgres.integration.test.ts`

Evidence:

`runIntent` selected the intent row and later updated it inside a transaction
without a row lock. Under PostgreSQL READ COMMITTED, concurrent cancellation,
redrive, or outcome writes can read the same row and overwrite each other.

Fix:

- Intent selection uses `SELECT ... FOR UPDATE` on PostgreSQL and MySQL and
  `WITH (UPDLOCK, ROWLOCK)` on SQL Server.
- SQLite keeps its existing statement because transactions serialize writers.
- PostgreSQL integration still passes with the locking query.

Status: Fixed and verified on PostgreSQL 17. A concurrent delivery isolation test
was added; multi-worker load testing is still recommended.

### RF-17: Queue IDs could collide across tenant/delivery boundaries

Severity: Medium

Files:

- `src/queue/Submissions.ts`
- `test/Queue.test.ts`

Evidence:

Queue IDs used raw `tenantId:deliveryId:generation` concatenation. Values
containing the separator could collide, mirroring the destination ID issue fixed
in RF-03.

Fix:

- Tenant and delivery components are URI-encoded before concatenation.
- Added a collision regression test.

Status: Fixed and tested.

### RF-18: Suppression SQL scanned all tenant rows per check

Severity: Medium

Files:

- `src/Suppression.ts`

Evidence:

`isSuppressed` and `suppressed` loaded every suppression row for a tenant and
filtered in JavaScript. Admission calls this on every submission.

Fix:

- Single-recipient checks query the primary key directly.
- Multi-recipient checks use an indexed `IN` query.
- Expiry filtering remains in memory for the fetched rows only.

Status: Fixed and functionally tested. Query-plan verification on PostgreSQL is
still recommended.

### RF-19: Provider event listing was nondeterministically ordered

Severity: Medium

Files:

- `src/DeliveryStore.ts`
- `src/DeliveryStoreSql.ts`
- `test/DeliveryStore.test.ts`

Evidence:

Memory events were returned in insertion order while SQL used no `ORDER BY`.
Workflows and diagnostics that take the first event could pick a different event
depending on backend and insert timing.

Fix:

- Memory events are sorted by `occurredAt`, then event ID.
- SQL event queries use `ORDER BY occurred_at, event_id`.
- Added a memory ordering regression test.

Status: Fixed and tested.

### RF-20: Retention queries lacked supporting indexes

Severity: Medium

Files:

- `src/DeliveryStoreSql.ts`
- `migrations/0001_delivery_store.sql`
- `migrations/0002_delivery_store_columns.sql`

Evidence:

`prune` filters intents by `status` and `updated_at` and events by
`occurred_at`, but only status/type/delivery indexes existed. Retention scans
could degrade on large tables.

Fix:

- Added `intents(updated_at)` and `events(occurred_at)` indexes to runtime DDL
  and both migration paths.
- Re-ran the PostgreSQL integration test with the new DDL.

Status: Fixed and verified.
### RF-25: HTTP request bodies had no size limit

Severity: High

Files:

- `src/server/Gateway.ts`
- `test/NodeServer.test.ts`

Evidence:

JSON submission and provider-event bodies were parsed without a request size
bound. A client could force the server to buffer an arbitrarily large body.

Fix:

- `Gateway.make` accepts `maxBodySize` and defaults to 10 MiB.
- The handler rejects declared oversized `Content-Length` requests with HTTP 413
  before parsing.
- The limit is also provided to `HttpServerRequest.MaxBodySize` for streamed
  request bodies.
- Added a Node HTTP regression test with a 1 KiB limit.

Status: Fixed and tested.

### RF-26: Gateway had no route authorization hook

Severity: High

Files:

- `src/server/Gateway.ts`
- `test/Gateway.test.ts`

Evidence:

Submission admission had an authorize hook, but status, event, redrive,
diagnostics, and cancellation routes had no caller authorization at all.

Fix:

- `Gateway.make({ authorize })` runs before every non-health route.
- Authorization failures use the normal `EmailError` mapping, including HTTP 401
  for `AuthenticationFailed` and 403 for authorization capability failures.
- Added a regression test proving operational routes are denied while health
  remains available.

Status: Fixed as a deployment hook. The default `Gateway.handler` remains
unauthenticated and must not be exposed directly; see RF-27.
### RF-31: SMTP authentication was not required by default

Severity: High

Files:

- `src/smtp/Session.ts`
- `test/SmtpSession.test.ts`

Evidence:

When an `authenticate` callback was configured but `requireAuthentication` was
omitted, the server still accepted MAIL, RCPT, and DATA without authentication.
This made an accidentally open relay the default for authenticated setups.

Fix:

- `runSession` now requires authentication whenever an authenticator is
  configured, unless `requireAuthentication: false` is explicitly set.
- Added a regression test proving MAIL is rejected with 530 when credentials are
  configured and no authentication has occurred.

Status: Fixed and tested.

### RF-32: SMTP transactions had no recipient limit

Severity: Medium

Files:

- `src/smtp/Session.ts`
- `src/smtp/Node.ts`
- `test/SmtpSession.test.ts`

Evidence:

RCPT TO appended to an unbounded in-memory array. A client could create
arbitrarily large transactions within the message size limit.

Fix:

- Added `maxRecipients` with a default of 100.
- Excess RCPT commands receive 452 and are not added.
- Added a regression test.

Status: Fixed and tested.

### RF-33: SMTP MIME was built after starting the DATA transaction

Severity: Medium

Files:

- `src/providers/Smtp.ts`

Evidence:

`buildMime` and DKIM signing ran after MAIL, RCPT, and DATA had begun. Local
attachment/template failures left an open DATA transaction and made failure
semantics depend on connection teardown.

Fix:

- MIME construction and DKIM signing now happen before MAIL FROM.
- Local content failures are classified before the provider transaction starts.

Status: Fixed; existing SMTP client, MIME, and DKIM tests pass.

### RF-34: SMTP client had no bound on multiline reply length

Severity: Medium

Files:

- `src/providers/Smtp.ts`

Evidence:

A malicious or broken server could send an unbounded multiline reply, keeping
the client reading indefinitely.

Fix:

- Multiline replies are capped at `maxReplyLines` (default 100).
- Reply line length is bounded by `maxLineBytes` (default 4096).
- Excess replies produce `MalformedProviderResponse`.

Status: Fixed; both client limits are configurable per SMTP client.
## Phase 3 provider findings fixed

| ID | Severity | Fix |
| --- | --- | --- |
| RF-41 | Critical | Cloudflare REST now uses `{ address, name }`, `reply_to`, `content_id`, and `result.message_id`; synthetic IDs removed. |
| RF-42 | Critical | Cloudflare Workers binding now uses `{ email, name }` for all addresses. |
| RF-43 | High | Brevo idempotency moved into the request body, batch keys made request-unique, and attachment fingerprints now include bytes/content ID. |
| RF-44 | High | Mailbreeze now sends string addresses and string arrays, matching its API. |
| RF-45 | High | Mailgun now decodes base64 attachment sources instead of sending base64 text as file bytes. |
| RF-46 | High | Mailcrab delete/clear now accept empty successful responses. |
| RF-47 | High | Mailpit delete/clear now accept empty successful responses. |
| RF-48 | High | SES throttling (`400 ThrottlingException`/`LimitExceededException`) maps to retryable `RateLimited`; 5xx maps to `DeliveryUncertain`. |
| RF-49 | High | AhaSend 409 maps to retryable `RateLimited`; partial conversation results map to `DeliveryUncertain`. |
| RF-50 | High | SMTP2GO partial success (`succeeded > 0` with failures) maps to `DeliveryUncertain`. |
| RF-51 | High | Tags are now restricted to header-safe tokens, closing tag-derived header-name injection paths. |
| RF-52 | Medium | Legacy Cloudflare binding rejects raw MIME plus attachments and no longer fabricates a provider message ID. |
| RF-53 | Medium | Cloudflare Workers binding advertises recipient limits, returns `UnsupportedCapability` for local limits, treats delivery failures as uncertain, and rejects multiple Reply-To addresses. |
| RF-54 | Medium | Mailtrap provider-template payloads no longer include forbidden subject/category fields. |
## Open findings from Phase 0/1

### RF-08: MessageDraft inputs bypass input-schema validation

Severity: Low

Files:

- `src/Message.ts`
- `src/Email.ts`

Evidence:

`Message.isDraft` uses `"content" in input`. `Message.prepare` trusts a value
classified as a draft and does not re-normalize addresses, headers, tags, or
attachments. This is safe through the HTTP gateway, which decodes
`MessageInput`, but unsafe if untrusted JavaScript is allowed to construct a
draft-shaped object.

Recommended action:

- Treat drafts as an internal trusted type and document that boundary, or
  revalidate the normalized fields in `prepare`.

### RF-09: Message content references are not defensively copied

Severity: Low

Files:

- `src/Message.ts`

Evidence:

Raw MIME and attachment `content` buffers are retained by reference. Caller
mutation after preparation can change bytes that are later sent. Frozen objects
do not protect typed-array contents.

Recommended action:

- Copy raw MIME and attachment bytes during preparation where practical, or
  document that buffers must not be mutated until the send completes.

### RF-10: Mailbox parser is intentionally incomplete

Severity: Low

Files:

- `src/Message.ts`

Evidence:

The parser handles common display-name and domain cases but is not a full RFC
5322 mailbox parser. Quoted local parts, escapes, and IP literals are only
partially validated. The current checks block header breaks and common invalid
forms.

Recommended action:

- Keep the restricted parser if it matches supported behavior, but document the
  limitation and add fixtures for quoted locals, escapes, and IP literals.

### RF-11: Fallback delivery IDs are collision-prone

Severity: Low

Files:

- `src/Ids.ts`

Evidence:

When `crypto.randomUUID` is unavailable, `newDeliveryId` falls back to
`Date.now()` plus a process-local counter. Two processes or a restart in the
same millisecond can collide.

Recommended action:

- Require a cryptographic random source in supported runtimes, or make the
  fallback process/instance-unique.

### RF-12: No lint or static policy script

Severity: Info

Files:

- `package.json`

Evidence:

The project has `typecheck` and `test` but no lint script. Some issues above are
policy or API-shape problems that a lint rule would not catch, but a consistent
lint baseline would still help.

Recommended action:

- Add a supported lint command and include it in the review baseline.

### RF-13: Root gateway imports workflow code

Severity: Info

Files:

- `src/index.ts`
- `src/server/Gateway.ts`

Evidence:

`Gateway` imports `workflow/Submissions` to complete event waits. This keeps the
root entrypoint free of Node-only code, but it increases the root module graph
and makes `effect/workflow` part of gateway consumers.

Recommended action:

- Measure the root/gateway bundle impact. If material, inject event-completion
  through a small interface rather than importing the workflow module from the
  gateway.

### RF-21: Accepted outcomes can be acknowledged without durable state (fixed by RF-80)

Severity: Medium

Files:

- `src/queue/Submissions.ts`

Evidence:

RF-15 intentionally acknowledges a queue item when `recordAccepted` fails, which
avoids duplicate submission but leaves the intent `in-progress` with no receipt.
Without reconciliation, that delivery has no terminal status and remains in
diagnostics as pending work.

Recommended action:

- Add a reconciliation task that queries provider status or consumes provider
  events for stale `in-progress` intents and records accepted, uncertain, or
  failed outcomes.

### RF-22: Concurrent provider-event dedupe can surface a uniqueness error

Severity: Medium

Files:

- `src/DeliveryStoreSql.ts`

Evidence:

`appendProviderEvent` performs `SELECT` followed by `INSERT` inside a
transaction. Concurrent ingestion of the same event ID can both observe absence;
one insert then fails the unique constraint instead of returning `false`.

Recommended action:

- Use a dialect-specific `INSERT ... ON CONFLICT DO NOTHING RETURNING` path, or
  translate a duplicate-key error into `false`.

### RF-23: Corrupt SQL JSON becomes a defect during listing

Severity: Low

Files:

- `src/DeliveryStoreSql.ts`

Evidence:

`JSON.parse`, `DateTime.makeUnsafe`, and schema casts run without a typed error
boundary on list/snapshot paths. A corrupt row can defect a worker or readiness
check instead of producing `StoreUnavailable`.

Recommended action:

- Decode with a checked schema and map malformed rows to `StoreUnavailable` with
  the delivery or event ID.

### RF-24: Runtime SQLite DDL cannot upgrade older tables

Severity: Low

Files:

- `src/DeliveryStoreSql.ts`
- `migrations/0002_delivery_store_columns.sql`

Evidence:

PostgreSQL has a backfill migration for installations created before the
denormalized columns existed. SQLite and custom-prefix installations rely on
`CREATE TABLE IF NOT EXISTS`, which does not add missing columns.

Recommended action:

- Document SQLite/custom-prefix upgrade requirements, or add a dialect-aware
  schema check with `ALTER TABLE ... ADD COLUMN`.
### RF-27: Default Gateway handler is unauthenticated

Severity: High

Files:

- `src/server/Gateway.ts`
- `README.md`

Evidence:

`Gateway.handler` keeps backward-compatible behavior with no authorization.
Every route, including redrive, diagnostics, cancellation, and provider events,
is open unless callers use `Gateway.make({ authorize })` behind their own ingress.

Recommended action:

- Make an authorization hook mandatory in the stable API, or clearly gate the
  default handler behind an explicit development-only constructor.

Status: Fixed by RF-70.

### RF-28: Provider event ingestion has no authenticity check

Severity: High

Files:

- `src/server/Gateway.ts`

Evidence:

Provider events are accepted from any caller that can reach the endpoint. There
is no signature, shared secret, timestamp window, or provider-specific
verification. Event IDs provide deduplication, not authenticity.

Recommended action:

- Add a provider-event verifier hook or built-in signature verification, reject
  stale timestamps, and require caller authorization before appending events.

Status: Fixed by RF-71; provider-specific verifier helpers remain future work.

### RF-29: Provider events are not checked against their delivery

Severity: Medium

Files:

- `src/server/Gateway.ts`

Evidence:

An event can be appended for a delivery ID that does not exist in the store.
Ingestion does not verify tenant ownership or that the provider message ID
matches the stored receipt.

Recommended action:

- Resolve the delivery before appending, verify tenant/provider correlation, and
  decide explicitly whether orphan events are accepted for reconciliation.

### RF-30: Catcher exposes full message data without authorization

Severity: High

Files:

- `src/server/Catcher.ts`
- `README.md`

Evidence:

`Catcher.handler` lists all tenants and returns full message bodies, recipients,
provider IDs, and errors. It is development-only but has no built-in guard.

Recommended action:

- Add the same authorization hook as the gateway, bind it to localhost in
  development defaults, or remove it from any exposed server assembly.

Status: Fixed by RF-72.

### RF-35: SMTP server had no connection or duration limits

Severity: Medium

Files:

- `src/smtp/Node.ts`
- `src/smtp/Session.ts`

Evidence:

Each accepted socket got a session with no maximum concurrent connection count
and no session timeout. Message and line limits bounded individual sessions, not
the number of sessions or their duration.

Fix:

- Added `maxConnections` with a scoped semaphore.
- Added `maxSessionMillis` with a timeout around session execution.
- Both are optional and validated; invalid or non-positive values disable the
  corresponding limit.

Status: Fixed; limits are configurable at the Node adapter boundary. Per-IP
limits remain an operational concern for a fronting proxy.

### RF-36: DKIM private keys are plain strings

Severity: Medium

Files:

- `src/smtp/Dkim.ts`
- `src/providers/Smtp.ts`

Evidence:

`DkimOptions.privateKey` is a plain string. The library does not log it, but
configuration structures and error inspection can expose it more easily than a
redacted value.

Recommended action:

- Accept and store the key as `Redacted<string>`, extracting it only at the
  signing call.

### RF-37: MIME headers are not folded for long or non-ASCII values

Severity: Medium

Files:

- `src/smtp/Mime.ts`

Evidence:

Address lists, subjects, and custom header values are emitted as single lines.
Long UTF-8 subjects or large recipient lists can exceed RFC line-length limits.
Non-ASCII attachment filenames are quoted as raw UTF-8 rather than RFC 2231
encoded.

Recommended action:

- Add header folding, encoded-word splitting, and RFC 2231 filename encoding.

### RF-38: SMTP client is plaintext unless TLS is explicitly configured

Severity: Medium

Files:

- `src/providers/Smtp.ts`

Evidence:

`secure` and `startTls` default to false. The client refuses plaintext AUTH by
default, but messages without AUTH can still be sent unencrypted without an
explicit warning.

Recommended action:

- Add an explicit `requireTls` default for non-local hosts, or log/deny
  plaintext submission unless explicitly allowed.

### RF-39: Pooled SMTP retries include rejected and authentication failures

Severity: Low

Files:

- `src/providers/Smtp.ts`

Evidence:

`makePooled` retries any error whose certainty is not `unknown`, including
`ProviderRejected` and `AuthenticationFailed`. Those failures are not
transient and a second new connection is unlikely to change the result.

Recommended action:

- Retry only retryable transport failures and connection-death cases.

### RF-40: SMTP AUTH failures are not rate-limited

Severity: Medium

Files:

- `src/smtp/Session.ts`
- `src/smtp/Node.ts`

Evidence:

A client can retry AUTH PLAIN indefinitely on one connection. There is no
failure count, delay, or connection termination policy.

Recommended action:

- Add failed-auth throttling and disconnect after a small number of failures.
## Phase 3 provider findings open

| ID | Severity | Finding |
| --- | --- | --- |
| RF-55 | Fixed | Error causes are sanitized by constructors; see RF-73. |
| RF-56 | Medium | Brevo `retrieve`/`cancel` target scheduled-email endpoints while capabilities say unsupported; remove the methods or restrict them to scheduled sends. |
| RF-57 | Medium | Resend 409 idempotency responses are classified as `ProviderRejected`; distinguish retryable concurrent requests from key-reuse conflicts. |
| RF-58 | Medium | Loops 409 idempotency responses are treated as rejections; provider IDs are synthesized from client keys/recipient emails; tag variables can overwrite template data. |
| RF-59 | Medium | Scaleway overstates recipient/attachment limits, defaults attachments to `application/octet-stream`, keeps only the first recipient email ID, and its non-retryable quota flag is ignored by shared retry logic. |
| RF-60 | Medium | SES does not encode display names, does not enforce tag constraints or recipient/raw-size limits, and does not parse Retry-After. |
| RF-61 | Medium | MailerSend does not enforce its 10-CC/10-BCC and 5-tag limits. |
| RF-62 | Medium | Mailtrap batch outcomes discard per-message `success: false` and errors, turning definite rejections into uncertainty. |
| RF-63 | Medium | Zeptomail uses one batch `request_id` for every provider message ID and has incomplete auth/rate code extraction. |
| RF-64 | Low | Azure Communication lacks Retry-After parsing, recipient/attachment limits, and redacted credential options. |
| RF-65 | Low | Postmark/Resend/SendGrid do not normalize trailing slashes in custom base URLs. |
| RF-66 | Low | SendGrid batch receipts share one request-level message ID, and tag/category limits are not enforced. |
| RF-67 | Low | Mailjet sends inline-disposition attachments without Content-ID as regular attachments and uses `CustomID` as if it were idempotency. |
### RF-70: Default Gateway handler allowed unauthenticated access

Severity: High

Files:

- `src/server/Gateway.ts`
- `test/Gateway.test.ts`

Evidence:

`Gateway.handler` exposed every non-health route without authorization.

Fix:

- `Gateway.handler` and `Gateway.make` now deny non-health routes unless an
  `authorize` hook is supplied.
- Health remains available for probes.
- Added a default-deny regression test.

Status: Fixed.

### RF-71: Provider events could be ingested without verification

Severity: High

Files:

- `src/server/Gateway.ts`
- `test/Gateway.test.ts`

Evidence:

Event ingestion accepted any JSON body from any authorized caller. Event IDs
provided deduplication, not authenticity.

Fix:

- Added `GatewayOptions.verifyEvent`, receiving the request, decoded event, and
  raw body for signature/HMAC validation.
- Event ingestion denies by default unless a verifier is supplied.
- Added a default-deny regression test.

Status: Fixed. Provider-specific signature helpers remain future work.

### RF-72: Catcher exposed message data without authorization

Severity: High

Files:

- `src/server/Catcher.ts`
- `test/Catcher.test.ts`

Evidence:

`Catcher.handler` listed all tenants and returned full message bodies without a
guard.

Fix:

- Added `Catcher.make({ authorize })`.
- `Catcher.handler` denies by default with HTTP 401.
- Added a default-deny regression test.

Status: Fixed.

### RF-73: Transport error causes could expose provider credentials

Severity: High

Files:

- `src/EmailError.ts`
- `test/Email.test.ts`

Evidence:

Raw HTTP client errors were attached as `cause`; those errors can include request
headers with plaintext authorization values.

Fix:

- Error constructors sanitize causes to name/message or tag/message only.
- Nested requests, headers, stacks, and response bodies are discarded.
- Added a regression test asserting a secret authorization header is absent from
  the serialized error.

Status: Fixed.
### RF-74: Cancellation could not target a delivery before intent creation

Severity: High

Files:

- `src/DeliveryStore.ts`
- `src/DeliveryStoreSql.ts`
- `migrations/0004_cancellations.sql`
- `test/DeliveryStore.test.ts`
- `test/DeliveryStoreSql.test.ts`

Evidence:

`requestCancellation` required an existing intent, so a delayed workflow could
not be canceled before admission. Gateway cancellation returned an error and no
tombstone existed for the future intent.

Fix:

- Added durable cancellation tombstones in memory and SQL.
- `requestCancellation` records a tombstone when no intent exists.
- New intents inherit the cancellation flag.
- Redrive clears the tombstone.
- Added memory and SQL regression tests.

Status: Fixed and tested; PostgreSQL integration passes with the new table.

### RF-75: Delayed workflows ignored cancellation tombstones

Severity: High

Files:

- `src/workflow/Submissions.ts`
- `test/Workflow.test.ts`
- `test/Gateway.test.ts`

Evidence:

`SubmitAfterDelay` slept and then admitted unconditionally. Even with a
cancellation tombstone, the delayed workflow would queue the delivery.

Fix:

- The delayed workflow checks `isCancellationRequested` after the durable sleep.
- Canceled submissions fail with `SubmissionCanceled` instead of queuing.
- Gateway cancellation now succeeds for not-yet-admitted delivery IDs.
- Added workflow and gateway regression tests.

Status: Fixed and tested.
### RF-76: Resend 409 idempotency responses were indistinguishable

Severity: Medium

Files:

- `src/providers/Resend.ts`
- `test/Resend.test.ts`

Evidence:

Both concurrent idempotent requests and invalid idempotency-key reuse mapped to
`ProviderRejected`, so a retryable in-flight request was recorded as terminal.

Fix:

- `concurrent_idempotent_requests` maps to retryable `RateLimited`.
- Invalid idempotency-key reuse maps to `IdempotencyConflict`.
- Added both regression tests.

Status: Fixed and tested.

### RF-77: MailerSend CC/BCC/tag limits were not enforced

Severity: Medium

Files:

- `src/providers/MailerSend.ts`
- `test/MailerSend.test.ts`

Evidence:

Messages with more than 10 CC/BCC recipients or 5 tags reached the provider.

Fix:

- Added local `UnsupportedCapability` checks for 10 CC, 10 BCC, and 5 tags.
- Added a regression test.

Status: Fixed and tested.

### RF-78: Scaleway limits and attachment content type were over-claimed

Severity: Medium

Files:

- `src/providers/Scaleway.ts`

Evidence:

The adapter advertised 1,000 recipients, accepted unlimited attachments, and
defaulted missing attachment types to `application/octet-stream`, which Scaleway
rejects.

Fix:

- Advertises 10 recipients and enforces 10 attachments.
- Requires an explicit attachment `contentType`.
- Added capability checks before submission.

Status: Fixed.

### RF-79: SES display names, tags, and limits were unvalidated

Severity: Medium

Files:

- `src/providers/Ses.ts`
- `test/Ses.test.ts`

Evidence:

Display names were emitted raw, tags were not checked against SES constraints,
and recipient/raw-size limits were not advertised.

Fix:

- Display names are quoted or RFC 2047 encoded.
- SES tag character/length and 50-tag limits are enforced.
- Advertises 50 recipients and enforces a 10 MiB raw-message cap.
- Added SES throttling/server-error regression tests in this batch.

Status: Fixed.
### RF-80: Stale in-progress deliveries had no reconciliation path

Severity: Medium

Files:

- `src/queue/Submissions.ts`
- `test/Queue.test.ts`

Evidence:

If a provider accepted a message but the receipt could not be persisted, the
queue item was acknowledged to prevent duplicates and the intent stayed
`in-progress` indefinitely.

Fix:

- Added `Submissions.reconcileStale`, which scans stale `in-progress` intents,
  skips those with provider events, and records `DeliveryUncertain`.
- Added `runReconciler` for periodic execution.
- Added a regression test using the test clock.

Status: Fixed and tested.
### RF-81: Provider events did not project delivery status

Severity: Medium

Files:

- `src/DeliveryStore.ts`
- `src/DeliveryStoreSql.ts`
- `test/Gateway.test.ts`
- `test/DeliveryStoreSql.test.ts`

Evidence:

Appending a delivered/bounced/complained event left the intent at `accepted`.
Diagnostics and status endpoints never reflected provider outcomes.

Fix:

- Added `delivered`, `bounced`, and `complained` delivery statuses.
- Event ingestion projects terminal status and timestamp into the intent in
  memory and SQL.
- Pruning and terminal-work checks include the new statuses.
- Gateway and SQL tests assert the projected status.

Status: Fixed and tested.
## Phase 8 test, benchmark, and documentation findings

### RF-68: Benchmark measured cold-start noise

Severity: Low

Files:

- `bench/send.ts`

Evidence:

Repeated runs ranged from roughly 5,500/s to 14,800/s. The first run included
module/JIT warmup and made regressions hard to compare.

Fix:

- Added a 1,000-message warmup before the measured run.
- Two consecutive warmed runs measured 14,821/s and 14,047/s.

Status: Fixed.

### RF-69: Driver parity documentation was stale

Severity: Low

Files:

- `docs/driver-parity.md`
- `README.md`

Evidence:

The parity document still said tee mirroring was next, listed Brevo
retrieve/cancel without the scheduled-email limitation, and described local
template rendering and generic retrieval as unimplemented.

Fix:

- Updated tee, Brevo, template, retrieval, cancellation, and remaining-gap
  descriptions to match the current implementation.
- Updated README retrieval/cancellation wording.

Status: Fixed.

## Test audit

- Full suite after final changes: 244 passed, 1 skipped.
- Follow-up suite: 305 passed, including PostgreSQL 17 integration.
- CI workflow added at `.github/workflows/ci.yml` with a PostgreSQL 16 service.
- Earlier flake run: three consecutive passes at 232/1 skipped.
- No flaky failures observed.
- PostgreSQL integration remains gated by `DATABASE_URL`; it passed separately
  against PostgreSQL 16 during this review and PostgreSQL 17 in the follow-up.
- Provider tests are deterministic and use local HTTP/SMTP doubles.
- Remaining test gaps: provider webhook signatures, live-provider sandbox tests,
  multi-worker load tests, broader SMTP protocol fuzzing, common SMTP client
  integration, and long-header MIME/DKIM interoperability.

## Release recommendation

Status: **no open Critical or High findings.**

Suitable for controlled internal deployment with explicit gateway authorization,
event verification, and provider credentials. Before a stable public release,
close the remaining Medium/Low provider gaps and add concurrent-worker load
coverage.

Recommended next work:

1. Add concurrent-worker load tests.
2. Add provider-specific event signature helpers on top of `verifyEvent`.
3. Work through the remaining Medium/Low provider findings.
4. Add suppression and event retention policy review.
## Risk register status

The detailed hypotheses remain in `docs/review-plan.md`, section 13. Current
status from the review so far:

| ID | Status |
| --- | --- |
| R-01 Gateway event authenticity | Fixed; RF-71 |
| R-02 Operational endpoint authorization | Fixed; RF-70/72 |
| R-03 Suppression SQL scans tenant rows | Fixed; RF-18 |
| R-04 No delivered intent projection | Fixed; RF-81 |
| R-05 Event wait accepts first event | Open; Phase 5 |
| R-06 Cancellation does not interrupt delayed workflow | Fixed; RF-74/75 |
| R-07 Spool pruning ignores references | Open; Phase 4 |
| R-08 SQL store rehydrates per mutation | Open; performance, Phase 4 |
| R-09 Root workflow import | Open; see RF-13 |
| R-10 Runtime DDL and migration drift | Open; Phase 4 |
| R-11 Event replay under new ID | Open; Phase 6 |
| R-12 Capability claims exceed behavior | Partially fixed; RF-41..54, residual RF-56..67 |
| R-13 Error mapping drift | Open; Phase 4/6 |
| R-14 SMTP relay authorization | Mitigated by RF-31; throttling open RF-40 |
| R-15 TLS/AUTH pool state | Reviewed; session reset/pool invalidation present |
| R-16 MIME/DKIM edge coverage | Open; RF-37 |
| R-17 Spool retention deletes live references | Open; Phase 4 |
| R-18 Suppression bypass paths | Partially reviewed; Phase 5 |
| R-19 Optional workflow engine consistency | Open; Phase 5 |
| R-20 CI PostgreSQL and load tests | PostgreSQL CI fixed; load tests open |

## Files reviewed in Phase 6 SMTP

- `src/smtp/Protocol.ts`
- `src/smtp/Session.ts`
- `src/smtp/Node.ts`
- `src/smtp/Mime.ts`
- `src/smtp/Dkim.ts`
- `src/providers/Smtp.ts`
- `test/SmtpProtocol.test.ts`
- `test/SmtpSession.test.ts`
- `test/SmtpNode.test.ts`
- `test/SmtpClient.test.ts`
- `test/SmtpPool.test.ts`
- `test/Mime.test.ts`
- `test/Dkim.test.ts`
## Files reviewed in Phase 6 HTTP

- `src/server/Gateway.ts`
- `src/server/Catcher.ts`
- `src/server/Node.ts`
- `test/Gateway.test.ts`
- `test/Catcher.test.ts`
- `test/NodeServer.test.ts`
## Files reviewed in Phase 4

- `src/DeliveryStore.ts`
- `src/DeliveryStoreSql.ts`
- `src/queue/Submissions.ts`
- `src/Spool.ts`
- `src/Suppression.ts`
- `migrations/0001_delivery_store.sql`
- `migrations/0002_delivery_store_columns.sql`
- `migrations/0003_suppressions.sql`
- `docs/postgres.md`
- `test/DeliveryStore.test.ts`
- `test/DeliveryStoreSql.test.ts`
- `test/Queue.test.ts`
- `test/QueueSql.test.ts`
- `test/OutboxSql.test.ts`
- `test/Spool.test.ts`
- `test/Suppression.test.ts`
- `test/Postgres.integration.test.ts`

## Files reviewed in Phase 0-2

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `src/index.ts`
- `src/Ids.ts`
- `src/Message.ts`
- `src/EmailError.ts`
- `src/Submission.ts`
- `src/EmailTransport.ts`
- `src/Email.ts`
- `src/testing/RecordingTransport.ts`
- `src/render/Template.ts`
- `test/Email.test.ts`
- `test/Message.test.ts`
- `test/Policy.test.ts`
- `test/Batch.test.ts`
- `test/NativeBatch.test.ts`
- `test/Stream.test.ts`
- `test/Template.test.ts`

## Next review batch

1. Finish Phase 2 policy review: rate-limit oversize behavior, fallback
   capabilities, tee partial success, round-robin concurrency.
2. Start Phase 4 store review: delivery lifecycle, SQL atomicity, queue
   generation, retention references, suppression query cost.
3. Start Phase 6 HTTP security review: provider event authenticity, operational
   authorization, body limits, readiness and shutdown.
