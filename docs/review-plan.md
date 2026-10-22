# effect-email in-depth review plan

Prepared: 2026-10-22

## 1. Purpose

Review every tracked file and every user-visible feature in `effect-email` for:

- **Correctness**: behavior matches contracts, provider documentation, and the
  implementation plan; edge cases and failure paths are covered.
- **Security**: no secret leakage, injection, authorization bypass, tenant
  crossing, unsafe parsing, SSRF, unbounded resource use, or unsafe defaults.
- **Performance**: bounded memory, backpressure, pooling, query efficiency,
  indexes, concurrency limits, retry amplification control, and benchmarked
  hot paths.
- **Synergy**: services, layers, exports, policies, providers, stores, HTTP,
  SMTP, workflow, and tests compose without duplicated semantics, hidden
  dependencies, or contradictory behavior.

This is a review plan, not the review itself. No production behavior should
change until a finding has a reproduction or a clear contract violation.

## 2. Review guardrails

1. Start from a known-green baseline and record it.
2. Review contracts before implementations, then trace each implementation
   through admission, delivery, persistence, and response handling.
3. Treat every external boundary as hostile: HTTP bodies, provider responses,
   SMTP commands, MIME, attachments, headers, webhook events, SQL data, and
   workflow payloads.
4. Every finding must include file and line references, impact, reproduction or
   evidence, severity, and a proposed fix.
5. Do not mix broad refactors with review fixes. One finding, one focused
   change.
6. Preserve public API compatibility unless the API itself is the finding.
7. Add a regression test or a documented reason a test is impossible.
8. Re-run the full baseline after each batch of fixes.

## 3. Baseline gate

Run before review and after each fix batch:

```powershell
bun run typecheck
bun run test
```

Expected current baseline:

- Typecheck passes.
- 240 tests pass.
- 1 PostgreSQL integration test is skipped when `DATABASE_URL` is absent.
- 53 test files pass; 54 test files are discovered.

Run the gated PostgreSQL test against a disposable container:

```powershell
docker run --rm -d --name effect-email-pg-review `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=effect_email `
  -p 55432:5432 postgres:16-alpine

$env:DATABASE_URL = "postgres://postgres:postgres@localhost:55432/effect_email"
bunx vitest run test/Postgres.integration.test.ts
docker rm -f effect-email-pg-review
```

Also record:

- Package export surface: `bunx vitest run test/Packaging.test.ts`.
- Benchmark baseline after 1,000-message warmup: `bun bench/send.ts` =
  20,000 accepted in 1,349 ms (14,821/s) on 2026-10-22.
- Any environment warnings, flaky tests, or timing-sensitive tests.

There is currently no configured lint script. Add a lint review item rather than
inventing one mid-review.

## 4. Severity model

| Severity | Definition | Release impact |
| --- | --- | --- |
| Critical | Secret exposure, remote code execution, auth bypass, cross-tenant data access, silent wrong-recipient delivery | Blocks release |
| High | Duplicate delivery, lost delivery, broken idempotency, unbounded resource exhaustion, SSRF, invalid TLS, SQL injection | Blocks release |
| Medium | Incorrect capability/receipt, retry storm, data retention failure, operational blind spot, weak test oracle | Fix before stable release |
| Low | Naming, documentation drift, minor inefficiency, non-critical missing test | Schedule |
| Info | Observation or future improvement with no current impact | No action required |

Exit requires zero open Critical or High findings. Medium findings require an
owner and either a fix or an explicit accepted-risk note.

## 5. Review method for every file

For each file:

1. **Surface**: enumerate exports, services, layers, options, errors, and
   documented behavior.
2. **Callers**: find all imports and call sites. Review the file in the context
   of every caller, not in isolation.
3. **Invariants**: write the 3-10 properties that must always hold.
4. **Error paths**: inspect every `Effect.fail`, thrown exception, rejected
   promise, timeout, cancellation, and partial-write path.
5. **Boundaries**: inspect decoding, validation, normalization, header/body
   construction, SQL, and provider JSON.
6. **Resource bounds**: identify every loop, buffer, queue, collection, retry,
   timer, socket, and transaction. Verify a bound or a proof of termination.
7. **Security**: apply the checklist in section 9 to the file's trust boundary.
8. **Performance**: apply the checklist in section 10 to the file's hot path.
9. **Synergy**: verify naming, error taxonomy, layer wiring, and semantics match
   adjacent modules.
10. **Evidence**: record tests read, tests run, new test/benchmark added, or why
    evidence is not possible.
11. **Verdict**: pass, pass with findings, or blocked.

## 6. Workstream sequence

### Phase 0: Inventory and contract map

Files:

- `src/index.ts`
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `bun.lock`
- `effect-email-implementation-plan.md`
- `README.md`
- `effect-v4-api-scope.md`
- `effect-schema.md`
- `effect-ecosystem.md`
- `effect-adjacent-projects.md`
- `docs/driver-parity.md`
- `docs/runtime-matrix.md`
- `docs/postgres.md`

Checks:

- Build a dependency graph from exports to implementations.
- Confirm every public export points to a real file and has an owner.
- Confirm root exports stay free of providers, Node-only adapters, and SMTP
  server code.
- Confirm the documented provider count, feature count, and test count match the
  repository.
- Confirm the pinned upstream commit and provider parity manifest are consistent.
- Inspect dependency provenance and duplicate Effect platform versions.
- Record known deferred scope: normalized attempt/receipt history, workflow-aware
  cancellation, provider webhook signature verification, scheduled retention,
  CI PostgreSQL, and load testing.

Exit evidence:

- Updated dependency graph.
- Package surface diff or confirmation.
- Baseline command output.

### Phase 1: Core contracts and immediate send path

Files:

- `src/Ids.ts`
- `src/Message.ts`
- `src/EmailError.ts`
- `src/Submission.ts`
- `src/EmailTransport.ts`
- `src/Email.ts`
- `src/testing/RecordingTransport.ts`

Checks:

- Branded IDs cannot be forged accidentally; generation and validation are
  deterministic where required.
- Message parsing rejects malformed mailboxes, header injection, CR/LF, invalid
  encodings, and contradictory content forms.
- Normalization preserves display names, domains, and address semantics; output
  types are immutable or defensively copied.
- Error taxonomy is exhaustive, stable, and mapped consistently to certainty,
  retryability, HTTP status, and queue outcome.
- Receipts preserve delivery ID, destination, provider message ID, and batch
  ordering.
- `Email.send`, batch, stream, and concurrency paths share the same validation
  and error mapping.
- Chunk ordering, global indices, short-circuit behavior, and partial failures
  are correct under concurrency.
- Recording transport cannot accidentally ship production data and redacts
  secrets.

Exit evidence:

- Contract tests for identity, normalization, errors, receipts, batch, stream,
  and recording transport.
- A table mapping every `EmailError` tag to retryability, certainty, and gateway
  status.

### Phase 2: Policies and transport composition

Files:

- `src/EmailTransport.ts`
- `test/Policy.test.ts`
- `test/RoundRobin.test.ts`
- `test/Tee.test.ts`
- `test/NativeBatch.test.ts`
- `test/Batch.test.ts`
- `test/Stream.test.ts`

Checks:

- Retry uses only retryable errors and cannot replay a provider-accepted send.
- Retry delays, jitter, total budget, and cancellation are bounded.
- Rate limiter acquisition happens before provider submission and is released on
  every failure path.
- Circuit-breaker state transitions are correct under concurrent calls.
- Fallback routes preserve the original delivery identity and record which leg
  produced the receipt.
- Round-robin state is safe under concurrency and does not skip healthy routes.
- Tee produces explicit multi-receipt results, not a misleading single receipt.
- Policy order is documented and tested: retry vs fallback vs rate limit vs tee.
- Policy composition does not multiply attempts beyond the intended budget.

Exit evidence:

- Truth table or state-machine table for retry, fallback, rate limit, and circuit
  breaker.
- Tests for concurrent calls and cancellation.
- Failure-injection results proving no double submit.

### Phase 3: Provider adapters

Review every provider file:

- `src/providers/AhaSend.ts`
- `src/providers/AzureCommunication.ts`
- `src/providers/Brevo.ts`
- `src/providers/CloudflareEmail.ts`
- `src/providers/CloudflareEmailRest.ts`
- `src/providers/CloudflareEmailService.ts`
- `src/providers/Http.ts`
- `src/providers/Loops.ts`
- `src/providers/Mailbreeze.ts`
- `src/providers/MailChannels.ts`
- `src/providers/Mailcrab.ts`
- `src/providers/MailerSend.ts`
- `src/providers/Mailgun.ts`
- `src/providers/Mailjet.ts`
- `src/providers/Mailpit.ts`
- `src/providers/Mailtrap.ts`
- `src/providers/Mock.ts`
- `src/providers/Postmark.ts`
- `src/providers/Resend.ts`
- `src/providers/Scaleway.ts`
- `src/providers/SendGrid.ts`
- `src/providers/Ses.ts`
- `src/providers/Smtp.ts`
- `src/providers/Smtp2go.ts`
- `src/providers/Zeptomail.ts`

Per-provider checks:

- Authentication header/query/body placement, encoding, and redaction.
- Endpoint, method, path, and API version match current provider documentation.
- Request mapping covers text, HTML, templates, attachments, headers, tags,
  reply-to, CC, BCC, and raw MIME only where supported.
- Capability advertisement matches implemented methods exactly.
- Response decoding distinguishes accepted, rejected, rate limited, auth failed,
  malformed response, and transport failure.
- Provider message IDs and receipt destinations are extracted correctly.
- Retrieval, cancellation, and batch paths use the correct identifier and scope.
- Error bodies are bounded, parsed safely, and never reflected with secrets.
- HTTP client timeouts, connection reuse, and response size limits are safe.
- No provider module leaks Node-only modules into the root entrypoint.
- Provider tests cover success, provider rejection, rate limit, malformed JSON,
  missing identifier, and capability mismatch.

Provider-specific focus:

| Provider | Highest-risk areas |
| --- | --- |
| AhaSend | Sandbox result mapping, suppression signals, auth and error shape |
| Azure Communication | Long-running operation polling, status mapping, API version |
| Brevo | Template payload, attachment encoding, rate-limit shape |
| CloudflareEmail | Binding input shape and platform-only types |
| CloudflareEmailRest | REST auth, endpoint scope, response shape |
| CloudflareEmailService | Binding vs REST contract drift |
| Http | Generic mapping, header injection, SSRF-adjacent base URL handling |
| Loops | Template variables and suppression response semantics |
| Mailbreeze | Auth, suppression mapping, attachment shape |
| MailChannels | Suppression mapping, auth, provider-specific rejection semantics |
| Mailcrab | Local catcher behavior and accidental production exposure |
| MailerSend | Template fields, batch/attachments, rate-limit handling |
| Mailgun | Form vs JSON encoding, region endpoint, attachments |
| Mailjet | Nested message payload, base64 attachments, error array parsing |
| Mailpit | Local catcher behavior and accidental production exposure |
| Mailtrap | Sandbox vs production endpoint selection |
| Mock | Test determinism, failure modes, no accidental external effects |
| Postmark | Message stream, templates, bounce/error response |
| Resend | Idempotency key handling, tags, attachments, batch |
| Scaleway | Auth header, template payload, regional endpoint |
| SendGrid | Personalizations, dynamic templates, attachments, batch limits |
| Ses | SigV4 signing, raw MIME, region, clock skew |
| Smtp | Envelope vs header recipients, pooling, STARTTLS, AUTH |
| Smtp2go | Payload shape, attachments, error mapping |
| Zeptomail | Auth token scope, template payload, bounce fields |

Exit evidence:

- Provider matrix with columns: send, batch, retrieve, cancel, attachments,
  templates, raw MIME, idempotency, auth, tested errors.
- At least one negative-path test per provider.
- Confirmation that provider docs were checked on the review date.

### Phase 4: Delivery state, queues, SQL, retention, spool, suppression

Files:

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

Checks:

- Intent lifecycle transitions are explicit and impossible to skip illegally.
- `beginAttempt` generation checks prevent stale workers from writing.
- Every mutation has a single atomic commit boundary in memory and SQL.
- Queue offer and intent creation participate in the required transaction or are
  repaired by the outbox publisher.
- Queue claim, completion, redrive, exhaustion, and cancellation are idempotent.
- Retry timestamps and attempt budgets survive restart.
- SQL identifiers are safely quoted; no user-controlled identifier or value is
  interpolated unsafely.
- SQL indexes match actual filters and ordering.
- JSON payload decoding is strict enough to reject corrupt rows predictably.
- Provider events are deduplicated by event ID and correlated by delivery ID.
- Event ingestion and intent status projection agree. Review whether a delivered
  event should produce an observable terminal state.
- `DeliveryStore.prune` handles terminal statuses, expiry boundaries, event
  retention, and partial deletion atomically.
- `Spool.prune` does not delete content still referenced by queued or active
  deliveries. If reference counting is absent, document the operational risk.
- Suppression normalization covers display names, casing, whitespace, and raw
  SMTP envelopes.
- Suppression expiry boundaries are correct and pruning is not required for
  correctness.
- Suppression SQL does not load unbounded tenant data on every admission check.
- Migrations are idempotent, backfill legacy rows correctly, and match the
  runtime-created schema.
- Tenant isolation is enforced in every store query.

Exit evidence:

- State-machine table for delivery intent.
- SQL query plan review for all list/prune paths.
- PostgreSQL run covering migrations, rollback, retention, and suppression.
- Concurrency test for queue claim and stale generation writes.

### Phase 5: Admission, workflow, and cancellation

Files:

- `src/SubmissionAdmission.ts`
- `src/workflow/Submissions.ts`
- `test/Admission.test.ts`
- `test/Workflow.test.ts`

Checks:

- Authorization and route validation run before any durable write.
- Suppression runs before queueing and cannot be bypassed by SMTP, raw envelope,
  templates, CC/BCC, or case variants.
- Idempotent replay returns the same logical identity and does not duplicate work.
- Renderer snapshotting happens before admission commits responsibility.
- Workflow payloads are versioned and validate on replay.
- Durable delay, event wait, and event-before-wait behavior survive restart.
- Event completion targets the correct tenant, delivery, execution, and deferred.
- Event completion failure does not turn a successful event ingest into a 5xx.
- Interrupt, resume, and poll helpers have clear semantics and tests.
- Workflow-aware cancellation is either implemented or explicitly documented as
  missing; cancellation must not leave a delayed workflow able to submit later.
- Gateway event ingestion cannot cross tenants or resume the wrong execution.
- `Effect.serviceOption` use is intentional and documented: absence disables the
  feature, presence enables it.

Exit evidence:

- End-to-end tests for replay, suppression, delayed submit, event wait, event
  before wait, gateway event resume, and restart/replay where feasible.
- Cancellation matrix showing what is stopped, what is merely flagged, and what
  may still execute.

### Phase 6: HTTP, SMTP, MIME, DKIM, and Node adapters

Files:

- `src/server/Gateway.ts`
- `src/server/Catcher.ts`
- `src/server/Node.ts`
- `src/smtp/Protocol.ts`
- `src/smtp/Session.ts`
- `src/smtp/Mime.ts`
- `src/smtp/Dkim.ts`
- `src/smtp/Node.ts`
- `test/Gateway.test.ts`
- `test/Catcher.test.ts`
- `test/NodeServer.test.ts`
- `test/SmtpProtocol.test.ts`
- `test/SmtpSession.test.ts`
- `test/Mime.test.ts`
- `test/Dkim.test.ts`
- `test/SmtpClient.test.ts`
- `test/SmtpNode.test.ts`
- `test/SmtpPool.test.ts`

HTTP checks:

- Request body limits, content-type handling, schema failures, and unknown routes.
- Authentication and authorization for submission and operational endpoints.
- Provider-event endpoint authenticity, replay protection, and tenant binding.
- Error responses do not leak internal messages, secrets, SQL, or stack traces.
- Status codes match error semantics, especially suppression, uncertainty, auth,
  rate limit, and store unavailability.
- Operational endpoints cannot be exposed as unauthenticated data dumps.
- Readiness reflects store health, not just process liveness.
- Graceful shutdown rejects new work and drains or releases active work.

SMTP checks:

- Line length, command count, DATA size, recipient count, and timeout bounds.
- CRLF injection, bare LF handling, pipelining, and command ordering.
- Envelope recipients vs header recipients and relay authorization.
- STARTTLS state reset, certificate verification, and downgrade prevention.
- AUTH PLAIN decoding, failure limits, and credential redaction.
- Pooled connections do not reuse a session with stale TLS or auth state.
- MIME boundary generation, attachment encoding, line endings, and header folding.
- MIME parsing is not part of inbound scope unless explicitly implemented.
- DKIM canonicalization, signing headers, private key handling, and clock.
- Server errors are specific enough for clients but not leaking internals.
- Local catcher cannot be accidentally enabled in production by default.

Exit evidence:

- HTTP threat-model table.
- SMTP transcript tests for malformed and fragmented input.
- TLS/AUTH integration tests.
- MIME/DKIM known-answer tests.

### Phase 7: Rendering, compatibility, package surface

Files:

- `src/render/Template.ts`
- `src/compat/CreateEmail.ts`
- `src/index.ts`
- `package.json`
- `test/Template.test.ts`
- `test/Compat.test.ts`
- `test/Packaging.test.ts`

Checks:

- Templates validate props at admission, snapshot output, and version correctly.
- HTML-to-text fallback is deterministic and safe.
- Renderer failures map to `TemplateError` without leaking template internals.
- Compatibility facade preserves Promise semantics, rejection shape, and batch
  ordering while not bypassing admission.
- Root exports remain stable, intentional, and free of Node-only modules.
- Every subpath export resolves.
- Dependency versions and overrides are consistent; no duplicate Effect platform
  runtime.
- Package names, `exports`, and file layout support the documented import paths.
- No public export accidentally exposes test-only or recording transports as a
  production recommendation.

Exit evidence:

- Export surface snapshot.
- Import smoke test for root and each subpath.
- Template snapshot and failure tests.

### Phase 8: Tests, benchmarks, and documentation

Files:

- All files under `test/`
- `bench/send.ts`
- `README.md`
- `docs/driver-parity.md`
- `docs/runtime-matrix.md`
- `docs/postgres.md`
- `effect-email-implementation-plan.md`
- Root Effect research notes

Checks:

- Tests assert behavior, not implementation details, and fail if the feature is
  removed.
- Mock providers cover realistic failure modes; no test depends on live network.
- Timing tests use the correct clock and are not flaky under load.
- PostgreSQL tests are gated and runnable in CI.
- Coverage gaps are mapped to features, not just files.
- Benchmarks measure the intended hot paths and report stable units.
- Docs match actual exports, defaults, limitations, and migrations.
- No documentation claims a capability that is missing or untested.
- Known limitations are explicit: normalized attempt/receipt history,
  workflow-aware cancellation, webhook signatures, scheduled retention, CI
  PostgreSQL, load testing.

Exit evidence:

- Test-to-feature matrix.
- Flake run: repeat the suite at least three times.
- Benchmark before/after only if a performance fix is made.
- Documentation diff review.

## 7. Review profiles

Use these profiles to keep the review consistent. A file can require more than
one profile.

| Profile | Applies to | Required checks |
| --- | --- | --- |
| CORE | Ids, Message, errors, submission receipts, transport contracts | Identity, validation, normalization, exhaustive errors, immutable outputs |
| POLICY | Retry, fallback, round-robin, tee, rate limit, circuit breaker | Retry safety, cancellation, concurrency, attempt budgets, receipt preservation |
| PROVIDER | Every `src/providers/*.ts` | Auth, mapping, capabilities, response decoding, error taxonomy, tests |
| STORE | Delivery store, SQL store, queue, spool, suppression, migrations | Atomicity, tenancy, indexes, retention, corruption handling, idempotency |
| ADMISSION | Submission admission and workflow | Authorization, suppression, replay, durable acceptance, event correlation |
| HTTP | Gateway, catcher, Node server | Body limits, auth, status mapping, event authenticity, shutdown |
| SMTP | SMTP protocol, session, MIME, DKIM, Node adapter, SMTP client | Framing, limits, STARTTLS, AUTH, relay rules, message construction |
| SUPPORT | Recording transport, templates, compatibility facade, package surface | Determinism, no production side effects, export stability, docs alignment |
| TEST | Every `test/*.ts` | Oracle strength, isolation, determinism, failure paths, feature mapping |
| OPS | Benchmarks, migrations, deployment docs, research notes | Reproducibility, schema drift, operational safety, accurate limitations |

## 8. Feature review matrix

Every row requires a correctness, security, performance, and synergy verdict.
The listed tests are the minimum starting evidence, not proof of coverage.

| Feature | Primary files | Starting tests | Highest-risk questions |
| --- | --- | --- | --- |
| Immediate send | `src/Email.ts`, `src/EmailTransport.ts` | `test/Email.test.ts`, `test/Mock.test.ts` | Validation before submit, acceptance certainty, error mapping |
| Batch send | `src/Email.ts` | `test/Batch.test.ts`, `test/NativeBatch.test.ts` | Ordering, concurrency, partial failure, duplicate indices |
| Stream send | `src/Email.ts` | `test/Stream.test.ts` | Backpressure, chunk bounds, cancellation, global ordering |
| Retry policy | `src/EmailTransport.ts` | `test/Policy.test.ts` | No replay after acceptance, bounded attempts, jitter, cancellation |
| Fallback routing | `src/EmailTransport.ts` | `test/Policy.test.ts` | Identity preservation, receipt leg, uncertainty handling |
| Round-robin | `src/EmailTransport.ts` | `test/RoundRobin.test.ts` | Concurrency, unhealthy routes, deterministic distribution |
| Tee | `src/EmailTransport.ts` | `test/Tee.test.ts` | Multi-receipt semantics, partial success, duplicate suppression |
| Rate limit and circuit breaker | `src/EmailTransport.ts` | `test/Policy.test.ts` | Acquire/release balance, shared state, outage recovery |
| Provider send | All `src/providers/*.ts` | Matching provider tests | Auth, payload shape, response mapping, capability honesty |
| Provider retrieval and cancel | Provider files with those methods | `test/Resend.test.ts`, `test/Brevo.test.ts`, `test/MailerSend.test.ts` | Identifier scope, unsupported capability behavior |
| Provider batch | Provider capability paths | Provider tests, `test/NativeBatch.test.ts` | Partial results, limits, duplicate IDs, fallback interaction |
| Templates | `src/render/Template.ts` | `test/Template.test.ts` | Admission-time snapshot, props typing, renderer failure, determinism |
| Attachments and raw MIME | Message, providers, SMTP MIME | `test/Message.test.ts`, `test/Mime.test.ts` | Encoding, size bounds, filename/header injection, spool references |
| SMTP client | `src/smtp/*`, `src/providers/Smtp.ts` | `test/SmtpClient.test.ts`, `test/SmtpPool.test.ts` | STARTTLS, AUTH, pooling, envelope/header mismatch |
| SMTP server | `src/smtp/*`, `src/server/Catcher.ts` | `test/SmtpNode.test.ts`, `test/SmtpSession.test.ts` | Relay authorization, limits, fragmentation, shutdown |
| MIME and DKIM | `src/smtp/Mime.ts`, `src/smtp/Dkim.ts` | `test/Mime.test.ts`, `test/Dkim.test.ts` | Folding, UTF-8, canonicalization, key handling |
| Admission and authorization | `src/SubmissionAdmission.ts` | `test/Admission.test.ts` | Authorize before write, route validation, durable responsibility |
| Suppression | `src/Suppression.ts`, `src/SubmissionAdmission.ts` | `test/Suppression.test.ts` | Normalization, tenant scope, bypass paths, SQL lookup cost |
| Idempotency | `src/Ids.ts`, stores, admission, providers | `test/Queue.test.ts`, `test/Admission.test.ts`, provider tests | Replay identity, conflicting content, duplicate provider submit |
| Durable queue and outbox | `src/queue/Submissions.ts` | `test/Queue.test.ts`, `test/QueueSql.test.ts`, `test/OutboxSql.test.ts` | Atomic offer, claim, redrive, exhaustion, stale workers |
| Delivery store | `src/DeliveryStore.ts`, `src/DeliveryStoreSql.ts` | `test/DeliveryStore.test.ts`, `test/DeliveryStoreSql.test.ts` | Lifecycle, generation checks, snapshot/restore, tenancy |
| Provider events | Store, gateway, workflow | `test/DeliveryStore.test.ts`, `test/Gateway.test.ts` | Dedupe, tenancy, authenticity, terminal projection |
| Retention | Store, spool, suppression | Store/spool/suppression tests | Cutoff boundaries, live references, atomic deletion |
| Delayed workflow | `src/workflow/Submissions.ts` | `test/Workflow.test.ts` | Durable timer, replay, cancellation, restart |
| Event-wait workflow | `src/workflow/Submissions.ts` | `test/Workflow.test.ts`, `test/Gateway.test.ts` | Event-before-wait, wrong event type, wrong execution, tenant |
| Cancellation | Store, queue, gateway, workflow | Admission/workflow tests, provider cancel tests | What is stopped, what is only flagged, late submission risk |
| HTTP gateway | `src/server/Gateway.ts` | `test/Gateway.test.ts` | Auth, body limits, status mapping, event authenticity, diagnostics |
| Catcher | `src/server/Catcher.ts` | `test/Catcher.test.ts` | Production exposure, tenant isolation, data redaction |
| Spool | `src/Spool.ts` | `test/Spool.test.ts` | Content addressing, copy isolation, reference safety, pruning |
| Compatibility facade | `src/compat/CreateEmail.ts` | `test/Compat.test.ts` | Promise semantics, admission preservation, rejection shape |
| Packaging | `src/index.ts`, `package.json` | `test/Packaging.test.ts` | Export stability, Node/provider leakage, dependency duplication |
| Diagnostics | `src/server/Gateway.ts`, stores | `test/Gateway.test.ts` | Auth, redaction, query cost, accurate counts |
| Benchmarks and docs | `bench/send.ts`, all docs | Manual review | Reproducibility, truthful claims, migration accuracy |
## 9. Security review checklist

Apply to every trust boundary:

### Secrets

- Credentials use `Redacted` or equivalent and never appear in logs, errors,
  receipts, snapshots, or test output.
- API keys are not placed in URLs when headers are supported.
- DKIM private keys and SMTP passwords have no accidental serialization path.
- Provider error bodies and request bodies are redacted before logging.

### Authorization and tenancy

- Every store key, workflow execution, suppression lookup, and gateway action is
  tenant-scoped.
- Cross-tenant delivery ID lookup cannot leak existence or content.
- Operational endpoints require authentication and authorization.
- Provider event ingestion authenticates the sender, or the docs state that it
  must sit behind a trusted ingress.
- Suppression cannot be bypassed by SMTP raw envelopes, CC/BCC, casing, display
  names, or malformed addresses.
- Cancel, redrive, and diagnostic actions are authorized per tenant.

### Input and injection

- Header values reject CR/LF and control characters.
- SMTP commands are length-bounded and parsed incrementally.
- MIME boundaries and headers cannot be injected by user content.
- SQL identifiers are allow-listed or safely quoted; values are parameterized.
- Provider base URLs are not attacker-controlled without an explicit SSRF
  decision.
- JSON response parsing has size and nesting bounds where applicable.
- `rawMime` and attachment content cannot escape the spool or filesystem.
- Template props cannot execute arbitrary code or escape the renderer sandbox.

### Resource exhaustion

- HTTP body size, SMTP DATA size, line length, recipient count, attachment count,
  and batch size have explicit limits.
- Retry, fallback, rate limit, and circuit breaker cannot create unbounded
  attempts.
- Timers, queues, pools, and broadcasts have shutdown and cancellation paths.
- Provider responses and error bodies are bounded.
- Spool and delivery retention have safe cutoffs and do not delete live data.

### Crypto and transport

- TLS verification is enabled; no insecure fallback is silent.
- STARTTLS downgrade is rejected.
- DKIM canonicalization and signing inputs are correct.
- Random IDs and secrets use cryptographic randomness where required.
- Timing-sensitive comparisons use constant-time primitives where relevant.

### Failure behavior

- Ambiguous provider outcomes become `DeliveryUncertain`, not false success.
- Accepted submissions are durably recorded before success is returned.
- Retry never resubmits a known-accepted delivery.
- Errors do not reveal whether another tenant's delivery exists.
- Cancellation and suppression win before provider submission.

## 10. Performance review checklist

### Hot paths

- `Email.send`, batch, and stream.
- Every provider request encoder and response decoder.
- Policy wrappers for retry, fallback, round-robin, tee, rate limit, and circuit
  breaker.
- Admission and queue offer.
- Delivery store mutations and list queries.
- Gateway JSON decoding and response encoding.
- SMTP DATA framing, MIME assembly, DKIM signing.
- Suppression check on every admission.
- Workflow execution and event completion.

### Required measurements or bounds

- Allocations per message for text, HTML, one attachment, and batch.
- Batch concurrency default and maximum.
- Stream chunk size, buffering, and backpressure behavior.
- Provider request body size limits.
- SQL query count per admission, attempt, completion, and redrive.
- Query plans for status lists and retention deletes.
- Suppression lookup cost relative to recipient count.
- Spool hash and copy cost for large attachments.
- SMTP pool checkout contention and connection reuse.
- Retry amplification under provider outage.
- Workflow timer and deferred retention growth.

### Performance risks to validate

- SQL delivery store rehydrates a memory store per mutation.
- Suppression SQL lists all tenant records then filters in memory.
- JSON encode/decode of whole intents on every state change.
- Event list scans within a delivery.
- Provider adapters may buffer full MIME or attachments unnecessarily.
- Tee may send identical content sequentially when parallel is intended.
- Diagnostics and failure listings may scan all intents.
- Gateway event ingestion may perform workflow lookup on every event.
- `Spool.prune` does not know which blobs are still referenced.

Every accepted performance finding needs a before/after benchmark or a query plan,
not only intuition.

## 11. Synergy and integration review

Check these cross-cutting contracts:

- `EmailTransport` capabilities match every provider's actual methods.
- `SubmissionReceipt` destination and provider ID survive fallback, tee, batch,
  queue, store, workflow, and gateway paths.
- `EmailError` tags map consistently to retryability, certainty, HTTP status,
  queue failure, and diagnostics.
- Admission, SMTP, and workflow all use the same suppression and authorization
  semantics.
- Queue, outbox, and workflow do not each create a different delivery identity.
- Event ingestion, event wait, and delivery status agree on what a provider event
  means.
- Cancellation semantics are consistent across store, queue, gateway, SMTP, and
  workflow.
- Retention semantics are consistent across delivery intents, provider events,
  suppressions, and spooled blobs.
- Root exports, subpath exports, docs, and tests all describe the same surface.
- Defaults are safe: no live provider by default, no catcher exposure, no
  unauthenticated operational listener, no insecure TLS, no infinite retry.
- Layers compose with a single shared instance of each store; optional services
  do not silently disable required behavior.

## 12. Test-suite audit matrix

Every test file must be reviewed for oracle quality, isolation, determinism, and
feature coverage.

### Core and policy

- `test/Email.test.ts`
- `test/Message.test.ts`
- `test/Email.test.ts` batch and stream sections
- `test/Batch.test.ts`
- `test/NativeBatch.test.ts`
- `test/Stream.test.ts`
- `test/Policy.test.ts`
- `test/RoundRobin.test.ts`
- `test/Tee.test.ts`
- `test/Mock.test.ts`

### Providers

- `test/AhaSend.test.ts`
- `test/AzureCommunication.test.ts`
- `test/Brevo.test.ts`
- `test/CloudflareBindings.test.ts`
- `test/CloudflareEmailRest.test.ts`
- `test/Http.test.ts`
- `test/Loops.test.ts`
- `test/Mailbreeze.test.ts`
- `test/MailChannels.test.ts`
- `test/Mailcrab.test.ts`
- `test/MailerSend.test.ts`
- `test/Mailgun.test.ts`
- `test/Mailjet.test.ts`
- `test/Mailpit.test.ts`
- `test/Mailtrap.test.ts`
- `test/Postmark.test.ts`
- `test/Resend.test.ts`
- `test/Scaleway.test.ts`
- `test/SendGrid.test.ts`
- `test/Ses.test.ts`
- `test/Smtp2go.test.ts`
- `test/Zeptomail.test.ts`

### Persistence and admission

- `test/DeliveryStore.test.ts`
- `test/DeliveryStoreSql.test.ts`
- `test/Queue.test.ts`
- `test/QueueSql.test.ts`
- `test/OutboxSql.test.ts`
- `test/Postgres.integration.test.ts`
- `test/Spool.test.ts`
- `test/Suppression.test.ts`
- `test/Admission.test.ts`
- `test/Workflow.test.ts`

### HTTP, SMTP, and package

- `test/Gateway.test.ts`
- `test/Catcher.test.ts`
- `test/NodeServer.test.ts`
- `test/SmtpProtocol.test.ts`
- `test/SmtpSession.test.ts`
- `test/SmtpClient.test.ts`
- `test/SmtpNode.test.ts`
- `test/SmtpPool.test.ts`
- `test/Mime.test.ts`
- `test/Dkim.test.ts`
- `test/Template.test.ts`
- `test/Compat.test.ts`
- `test/Packaging.test.ts`

For each test file record:

- Feature exercised.
- Real failure path exercised.
- Assertion strength.
- Shared-state or timing risk.
- Missing adjacent cases.
- Whether the test would catch the likely regression.

Cross-suite checks:

- Run the suite at least three times to detect flakes.
- Run with `DATABASE_URL` for PostgreSQL.
- Run packaging tests after any export change.
- Confirm no test requires real credentials or network access.
- Confirm skipped tests have a documented enablement path.

## 13. Seed risk register

These are hypotheses to validate, not confirmed defects.

| ID | Hypothesis | Area | Severity if true |
| --- | --- | --- | --- |
| R-01 | Gateway provider-event ingestion has no signature or caller authentication | Security | Critical/High |
| R-02 | Gateway operational endpoints have no built-in authorization | Security | High |
| R-03 | Suppression SQL loads the full tenant list per admission check | Performance | Medium |
| R-04 | Delivery event ingestion does not project a terminal delivered state | Correctness/Synergy | Medium |
| R-05 | `WaitForDeliveryEvent` resolves on the first event, not necessarily a terminal event | Correctness | Medium |
| R-06 | Cancellation does not interrupt delayed workflows, allowing later submission | Correctness | High |
| R-07 | Spool pruning can delete blobs still referenced by queued work | Correctness | High |
| R-08 | SQL delivery store rehydrates the memory store on every mutation | Performance | Medium |
| R-09 | Root gateway import now pulls workflow code into the root dependency graph | Synergy/Packaging | Medium |
| R-10 | Runtime table creation and migration DDL can drift for custom prefixes | Correctness | Medium |
| R-11 | Provider webhook events can be replayed under a new event ID | Security | High |
| R-12 | Provider capability claims may exceed implemented retrieval/cancel paths | Synergy | High |
| R-13 | Error mapping may differ between gateway, queue, retry, and diagnostics | Synergy | Medium |
| R-14 | SMTP relay authorization may be bypassed by envelope/header mismatch | Security | Critical |
| R-15 | TLS or AUTH state may leak across pooled SMTP connections | Security | High |
| R-16 | MIME/DKIM tests may not cover folding, UTF-8, or long headers | Correctness | Medium |
| R-17 | Retention can delete an intent while a redrive or workflow still references it | Correctness | High |
| R-18 | Suppression bypass via display names, malformed addresses, or raw envelopes | Security | High |
| R-19 | Optional `WorkflowEngine` behavior is inconsistent between event ingest and wait setup | Synergy | Medium |
| R-20 | No CI PostgreSQL service or load test means deployment-only failures | Operations | Medium |

## 14. Deliverables

At the end of the review, produce:

1. **Findings register**: ID, severity, area, file/line, evidence, impact, fix,
   test, owner, status.
2. **Feature matrix**: feature, files, tests, correctness/security/performance
   verdict.
3. **File sign-off table**: every tracked file marked reviewed with evidence.
4. **Threat model summary**: trust boundaries and accepted risks.
5. **Performance report**: baseline, hot paths, query plans, benchmarks, and
   unresolved risks.
6. **Test-gap report**: missing regression tests mapped to features.
7. **Release recommendation**: ship, ship with accepted risks, or block.

## 15. File sign-off checklist

Mark each file only after reading it, tracing its callers, applying the relevant
checklists, and recording evidence.

### Root and configuration

- [x] `.gitignore`
- [ ] `bun.lock`
- [x] `.github/workflows/ci.yml`
- [x] `package.json`
- [x] `tsconfig.json`
- [x] `README.md`
- [ ] `effect-email-implementation-plan.md`
- [ ] `effect-v4-api-scope.md`
- [ ] `effect-schema.md`
- [ ] `effect-ecosystem.md`
- [ ] `effect-adjacent-projects.md`

### Docs

- [x] `docs/driver-parity.md`
- [x] `docs/runtime-matrix.md`
- [x] `docs/postgres.md`

### Migrations

- [x] `migrations/0001_delivery_store.sql`
- [x] `migrations/0002_delivery_store_columns.sql`
- [x] `migrations/0003_suppressions.sql`
- [x] `migrations/0004_cancellations.sql`

### Core source

- [x] `src/index.ts`
- [x] `src/Ids.ts`
- [x] `src/Message.ts`
- [x] `src/EmailError.ts`
- [x] `src/Submission.ts`
- [x] `src/EmailTransport.ts`
- [x] `src/Email.ts`
- [x] `src/DeliveryStore.ts`
- [x] `src/DeliveryStoreSql.ts`
- [x] `src/Spool.ts`
- [x] `src/Suppression.ts`
- [ ] `src/SubmissionAdmission.ts`
- [x] `src/testing/RecordingTransport.ts`
- [ ] `src/compat/CreateEmail.ts`
- [x] `src/render/Template.ts`
- [x] `src/queue/Submissions.ts`
- [ ] `src/workflow/Submissions.ts`

### HTTP and Node

- [x] `src/server/Gateway.ts`
- [x] `src/server/Catcher.ts`
- [x] `src/server/Node.ts`

### SMTP

- [x] `src/smtp/Protocol.ts`
- [x] `src/smtp/Session.ts`
- [x] `src/smtp/Mime.ts`
- [x] `src/smtp/Dkim.ts`
- [x] `src/smtp/Node.ts`

### Providers

- [x] `src/providers/AhaSend.ts`
- [x] `src/providers/AzureCommunication.ts`
- [x] `src/providers/Brevo.ts`
- [x] `src/providers/CloudflareEmail.ts`
- [x] `src/providers/CloudflareEmailRest.ts`
- [x] `src/providers/CloudflareEmailService.ts`
- [x] `src/providers/Http.ts`
- [x] `src/providers/Loops.ts`
- [x] `src/providers/Mailbreeze.ts`
- [x] `src/providers/MailChannels.ts`
- [x] `src/providers/Mailcrab.ts`
- [x] `src/providers/MailerSend.ts`
- [x] `src/providers/Mailgun.ts`
- [x] `src/providers/Mailjet.ts`
- [x] `src/providers/Mailpit.ts`
- [x] `src/providers/Mailtrap.ts`
- [x] `src/providers/Mock.ts`
- [x] `src/providers/Postmark.ts`
- [x] `src/providers/Resend.ts`
- [x] `src/providers/Scaleway.ts`
- [x] `src/providers/SendGrid.ts`
- [x] `src/providers/Ses.ts`
- [x] `src/providers/Smtp.ts`
- [x] `src/providers/Smtp2go.ts`
- [x] `src/providers/Zeptomail.ts`

### Benchmarks

- [x] `bench/send.ts`

### Tests

- [x] `test/Admission.test.ts`
- [x] `test/AhaSend.test.ts`
- [x] `test/AzureCommunication.test.ts`
- [x] `test/Batch.test.ts`
- [x] `test/Brevo.test.ts`
- [x] `test/Catcher.test.ts`
- [x] `test/CloudflareBindings.test.ts`
- [x] `test/CloudflareEmailRest.test.ts`
- [x] `test/Compat.test.ts`
- [x] `test/DeliveryStore.test.ts`
- [x] `test/DeliveryStoreSql.test.ts`
- [x] `test/Dkim.test.ts`
- [x] `test/Email.test.ts`
- [x] `test/Gateway.test.ts`
- [x] `test/Http.test.ts`
- [x] `test/Loops.test.ts`
- [x] `test/Mailbreeze.test.ts`
- [x] `test/MailChannels.test.ts`
- [x] `test/Mailcrab.test.ts`
- [x] `test/MailerSend.test.ts`
- [x] `test/Mailgun.test.ts`
- [x] `test/Mailjet.test.ts`
- [x] `test/Mailpit.test.ts`
- [x] `test/Mailtrap.test.ts`
- [x] `test/Message.test.ts`
- [x] `test/Mime.test.ts`
- [x] `test/Mock.test.ts`
- [x] `test/NativeBatch.test.ts`
- [x] `test/NodeServer.test.ts`
- [x] `test/OutboxSql.test.ts`
- [x] `test/Packaging.test.ts`
- [x] `test/Policy.test.ts`
- [x] `test/Postgres.integration.test.ts`
- [x] `test/Postmark.test.ts`
- [x] `test/Queue.test.ts`
- [x] `test/QueueSql.test.ts`
- [x] `test/Resend.test.ts`
- [x] `test/RoundRobin.test.ts`
- [x] `test/Scaleway.test.ts`
- [x] `test/SendGrid.test.ts`
- [x] `test/Ses.test.ts`
- [x] `test/Smtp2go.test.ts`
- [x] `test/SmtpClient.test.ts`
- [x] `test/SmtpNode.test.ts`
- [x] `test/SmtpPool.test.ts`
- [x] `test/SmtpProtocol.test.ts`
- [x] `test/SmtpSession.test.ts`
- [x] `test/Spool.test.ts`
- [x] `test/Stream.test.ts`
- [x] `test/Suppression.test.ts`
- [x] `test/Tee.test.ts`
- [x] `test/Template.test.ts`
- [x] `test/Workflow.test.ts`
- [x] `test/Zeptomail.test.ts`

## 16. Final exit criteria

The review is complete only when:

- Every file in section 15 is checked with recorded evidence.
- Every feature in section 8 has correctness, security, performance, and synergy
  verdicts.
- No Critical or High findings remain open.
- Every Medium finding has a fix or an accepted-risk note.
- Full tests pass three consecutive runs.
- PostgreSQL integration passes against the supported database version.
- Package surface and root-entrypoint tests pass.
- Benchmark baseline is recorded, and any performance fix has before/after data.
- Documentation matches actual behavior and limitations.
- A release recommendation and residual-risk summary are written.
