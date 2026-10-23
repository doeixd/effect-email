# Service and feature improvement plan

Date: 2026-10-22
Initial baseline: `6ff0142137284a7000ee831d63fb6574d1c8ed1e`
Current baseline: `c812f87` (PR 10 partial)
Status: PR 1-4 and 6-8 complete; PR 5, 9, and 10 partial
Inventory: `docs/baseline-inventory.md`
Lifecycle decision: `docs/adr/0001-delivery-lifecycle.md`
Archived source plan: `docs/planning/effect-email-implementation-plan-2026-10-20.md`

## Progress tracker

| PR | Status | Evidence |
| --- | --- | --- |
| 1 | Complete | `5049082` adds the baseline inventory, lifecycle ADR, and updated docs |
| 2 | Complete | Shared retry decisions, permanent-error worker handling, response-loss regression, retry matrix tests |
| 3 | Complete | Native batch retry preserves indexes and accepted/uncertain slots; opt-in subset retry, fallback capability validation, composite limits, and policy-order docs added |
| 4 | Complete | Pure lifecycle transitions are shared by memory and SQL; SQL transitions no longer use memory restore/snapshot; parity coverage added |
| 5 | Partial | Atomic claims, atomic SQL creation, tenant storage/indexing, and embedded attempt history are implemented; composite tenant keys and normalized attempt storage remain |
| 6 | Complete | Publisher and reconciler use bounded tenant/outbox and stale-claim pages with supporting indexes |
| 7 | Complete | Shared admission preparation, `Routing.explain`, hard requirements, explicit-route diagnostics, and provider-template/registry boundaries documented |
| 8 | Complete | Events correlate through receipt message IDs and destination, preserve ingestion time, and project deterministically without regressing terminal state |
| 9 | Partial | Typed event waits, dispatch-time suppression, cancellation outcomes, and uncertain-redrive acknowledgment are implemented; automatic hard-bounce suppression and wait deadlines remain |
| 10 | Partial | PostgreSQL service example, three-level README, production assembly guide, glossary, and scoped shutdown are implemented; typed configuration errors and the optional runtime helper remain |
| 11-12 | Not started | See the PR sequence |

## 1. Objective

Make effect-email an approachable transactional-email library that can also
serve as a reliable, operable delivery service.

Preserve the strongest existing choices: transport values, Effect services and
layers, explicit provider capabilities, destination-aware receipts, submission
certainty, and durable delivery intents. Prioritize trustworthy composition and
understandable adoption over additional providers.

Success means a developer can send one message easily, add policies without
losing capabilities, and adopt durable delivery with documented failure and
recovery semantics.

## 2. Current baseline delta

The initial assessment predates the current baseline. The following findings are
already addressed:

| Finding | Current state |
| --- | --- |
| Resend pre-response failures were retryable `TransportUnavailable` | Production HTTP provider adapters classify pre-response request failures as `DeliveryUncertain`; status errors remain classified from their HTTP status |
| `withRetry` omitted `sendBatch` while retaining native-batch capabilities | `withRetry` preserves native batch dispatch and retries the batch only when the failure is eligible |
| SQL transitions restored through a shared memory store | SQL transitions use transaction-local delivery state |
| No concurrent PostgreSQL delivery evidence | Added concurrent delivery isolation coverage |
| The worker branched on certainty and retried permanent local failures | `src/RetryDecision.ts` now drives policy and worker decisions; permanent local failures stop after one attempt |
| Policy and worker encoded separate retry decisions | Shared retry decisions cover uncertainty, permanent errors, retryable rejections, rate limits, delays, and exhaustion |
| Native batch retry could not resume partial work safely | `withRetry` preserves original indexes, never replays accepted/uncertain slots, and offers opt-in `partialBatchRetry` |
| Fallback could dispatch to a target that lacked the required capability | Fallback revalidates the secondary; composite batch and recipient limits use the smaller leg |
| SQL transitions executed through a memory service | Memory and SQL now apply the same pure transitions from `src/DeliveryTransitions.ts` |
| Attempts had no exclusive claim | `beginAttempt` acquires `claimId`/`claimExpiresAt`; results from stale claims are rejected |
| SQL intent creation could overwrite a concurrent insert | SQL uses atomic insert-on-conflict and returns the existing intent or `IdempotencyConflict` |
| Background work scanned every intent | Publisher/reconciler use tenant and stale-claim pages ordered by delivery ID, with outbox/claim indexes |
| Admission and direct send validated at different points | Admission uses the same `Message.prepare` path before persisting |
| Route selection had no diagnostic surface | `Routing.explain` reports requirements, capability reasons, explicit-route exclusions, and preferences without sending |
| Provider events trusted caller-supplied delivery IDs and could regress state | Events correlate by receipt message ID/destination and project only allowed, newer outcomes |
| Event waits matched the first stored event | Waits can require explicit event types and re-check stored history |
| Suppression was checked only at admission | The worker re-checks suppression immediately before dispatch |
| Cancellation and redrive lacked truthful outcomes | Cancellation returns explicit outcomes; uncertain redrive requires duplicate-risk acknowledgment |
| Durable adoption required inferring assembly | Added `examples/postgres-service.ts`, production assembly guide, glossary, and adoption-level README |

Still current:

- Tenant identity is stored and indexed, but `delivery_id` remains the primary
  key and the API does not require tenant scoping.
- Attempt history is embedded in intent JSON; a normalized attempt table remains
  future work.
- Suppression service discovery remains optional; production assembly must
  enforce it.
- Automatic hard-bounce/complaint suppression and typed-wait deadlines remain.
- Registry routes are captured at layer construction; live reconfiguration
  remains deferred.
- Remote attachment URLs are not content-addressed for durable replay.
- Some startup configuration failures are still defects rather than typed errors.

## 3. Target ownership

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Message preparation | Normalize, validate, render, derive requirements | Network submission or durable scheduling |
| Transport | Execute one provider attempt and report its outcome | Business scheduling or global delivery lifecycle |
| Transport policy | Explicit local retry, fallback, throttling, circuit behavior | Hidden durable resubmission |
| Email | Prepare, select routes, dispatch, normalize outcomes | Mandatory SQL or workflow setup |
| SubmissionAdmission | Authorize, snapshot, enforce admission, persist intent | Claim that provider acceptance occurred |
| DeliveryStore | Authoritative lifecycle, attempts, claims, events | Provider network calls inside SQL transactions |
| Queue worker | Claim and dispatch eligible attempts, record outcomes | Business-process orchestration |
| Workflow | Business delays, event predicates, coordination | A second provider retry loop |
| Gateway/SMTP | Authenticate, establish tenant context, invoke admission | A parallel delivery implementation |

Keep `Transport` a value. Keep provider `Client` services where native
functionality warrants them. Keep `EmailTransport` as a single-provider
convenience. Keep static routes as the default and `TransportRegistry` for
composition. Do not add a universal builder DSL.

## 4. Adoption levels

### Direct

`Email.layerTransport` or `Email.layer` plus `Email.send`. No persistence.

Guarantee: one prepared submission attempt through the selected transport. An
uncertain result is not retried.

### Resilient

The same API with explicit retry, fallback, rate limit, round-robin, tee, or
circuit-breaker wrappers.

Guarantee: bounded local policy behavior. Durable resubmission is not implied.
An uncertain result is never failed over.

### Durable

`SubmissionAdmission` plus a persistent `DeliveryStore`, persisted queue,
worker, publisher, and reconciler. Workflows and gateways remain optional.

Guarantee: durable admission, recoverable outbox, observable lifecycle, and
truthful uncertainty. External delivery is not exactly once.

Each level needs a complete executable example, an explanation of its receipt,
and a short guarantee table. Memory examples must state that they do not survive
process loss.

## 5. Invariants

- Provider acceptance differs from admission and from recipient delivery.
- An uncertain outcome is not automatically retried or sent to another provider.
- Advertised capabilities correspond to available, semantically correct
  operations.
- Every original batch slot has exactly one normalized outcome with its original
  index.
- Tenant context participates in durable identity, authorization, lookup, and
  event correlation.
- Each attempt has an exclusive claim; stale attempts cannot overwrite a newer
  generation.
- Cancellation prevents future dispatch where possible; it does not promise
  recall.
- Replay preserves rendered content, attachment identity, and envelope data.
- Late and duplicate events cannot arbitrarily regress delivery state.
- Retention never deletes content needed by queued or active work.
- Restart recovery does not imply exactly-once external delivery.

These are shared contract tests and release criteria, not documentation slogans.

## 6. Workstream A: submission certainty and retry decisions

Priority: P0.
Files: `src/EmailError.ts`, provider adapters, `src/EmailTransport.ts`,
`src/queue/Submissions.ts`.

Changes:

1. Audit each adapter's error mapping and record the evidence for
   `not-submitted`, `rejected`, and `unknown`. Do not classify only from whether
   an HTTP response arrived.
2. Map connection loss or timeout after possible transmission to
   `DeliveryUncertain`. Use `not-submitted` only when non-submission is provable.
   Default to uncertainty when the HTTP abstraction lacks phase information.
3. Separate retry eligibility from certainty. A permanent local failure is
   definitely not submitted but is not useful to retry.
4. Introduce an internal shared decision function used by policy wrappers and
   workers. Inputs: error, attempt budget, retry-after, destination, replay
   context. Outputs: stop, retry later, or reconcile uncertainty.
5. Preserve the conservative default for uncertain outcomes. Provider-idempotent
   replay requires the same destination/account, key, payload fingerprint, and a
   verified deduplication window. Never carry that permission across fallback.
6. Define retry ownership: durable workers own delayed retries by default.
   Short transport retries remain opt-in and count toward the total budget.
7. Persist why an attempt stopped and the next eligible retry time. Do not
   collapse permanent validation failures into generic queue exhaustion.

Acceptance:

- A test server accepts a request and drops the response; no automatic second
  send occurs.
- A proven pre-send failure is eligible for bounded retry.
- `InvalidMessage` and `UnsupportedCapability` terminate without consuming
  repeated queue attempts.
- `Retry-After` is honored; exhaustion is observable.
- Fallback never dispatches an uncertain slot to another destination.
- Shared cases produce consistent decisions through direct policy and worker
  paths.

## 7. Workstream B: capability-preserving composition

Priority: P0.
Files: `src/EmailTransport.ts`, `src/Email.ts`, policy and batch tests.

Changes:

1. Inventory every decorator against send, sendBatch, retrieve, cancel,
   destination, limits, and idempotency semantics.
2. Decorate operations explicitly. Do not blindly spread when each operation
   needs different wrapping.
3. Retry native batches by original slot index. Never replay accepted or
   uncertain slots. Respect provider request-level idempotency constraints when
   resubmitting a subset.
4. If a decorator intentionally removes batching, set `nativeBatch` to false and
   document the degradation. Prefer preserving it for retry and rate limiting.
5. Calculate composite capabilities carefully. Fallback validates the chosen
   target; round-robin selects only eligible targets. Composite limits are not
   copied blindly from the primary provider.
6. Preserve destination-aware retrieval and cancellation after routing and
   fallback. A same-provider second account is a different destination.
7. Document policy-order recipes without adding public combinators unless
   examples reveal a repeated need.

Policy-order contract:

| Composition intent | Required behavior |
| --- | --- |
| Rate limit around each physical attempt | Retries consume additional tokens |
| Rate limit around one logical send | Internal retries do not consume the outer limiter; document provider quota implications |
| Retry primary before fallback | Exhaust safe local attempts before failover |
| Retry a fallback group | Preserve per-destination history; do not restart accepted work |
| Tee | Return explicit multiple outcomes; distinguish required and best-effort mirrors |

Acceptance:

- Wrapping a native batch transport retains batching and indexed outcomes.
- Partial success plus transient failures sends only the permitted subset.
- Request, message, and recipient counts match documented limiter placement.
- Receipt operations reach the accepting account after two or more decorators.
- Circuit half-open probes recover correctly from interruption.

## 8. Workstream C: durable state and concurrency

Priority: P0.
Files: `src/DeliveryStore.ts`, `src/DeliveryStoreSql.ts`,
`src/queue/Submissions.ts`, migrations, SQL tests.

Changes:

1. Extract pure lifecycle transition functions shared by memory and SQL. Pass
   time, current state, and command explicitly; return new state and a typed
   result.
2. Remove restore/mutate/snapshot through a shared memory service from SQL
   transactions. Decode a transaction-local row, apply a pure transition, and
   persist that row.
3. Add atomic attempt claims with claim ID, generation, lease/expiry metadata,
   and expected state or revision. Do not hold SQL transactions open during
   network submission.
4. Define uncertain recovery for expired in-progress claims. Lease expiry does
   not prove failure and must not authorize an unsafe resend.
5. Make `createIntent` atomic under concurrent insertion. A uniqueness conflict
   fetches and compares the existing fingerprint, returning the existing intent
   or `IdempotencyConflict` without overwriting it.
6. Include tenant and delivery identity consistently. Prefer composite
   tenant/delivery keys, matching indexes, and an explicit legacy migration
   policy.
7. Persist per-attempt destination, timestamps, certainty, and provider
   identifiers. Retain a delivery-level summary for reads.
8. Replace all-row scans used by publisher/reconciler with indexed, bounded,
   cursor-paginated queries.
9. Preserve the outbox model: committed-but-unqueued intents are recoverable.
   Admission success acknowledges the committed intent, not queue publication.

Acceptance:

- Concurrent same-ID admission with identical payload creates one intent;
  different payload produces conflict.
- Independent delivery updates cannot contaminate each other.
- Two workers racing for one delivery acquire at most one active claim.
- Stale queue generations and attempt completions cannot overwrite current state.
- Crash after intent commit, before publication, recovers through the publisher.
- Crash after provider acceptance but before persistence produces observable
  uncertainty, not blind replay.
- Tests run against PostgreSQL with multiple connections, not only sequential
  memory doubles.

## 9. Workstream D: preparation, requirements, and route selection

Priority: P1; depends on A/B for safe dispatch.

Changes:

1. Factor normalization, rendering, and generic validation into one preparation
   path shared by admission and direct sending.
2. Derive hard requirements from prepared content: raw MIME, attachments, remote
   attachment handling, provider template identity, recipients, and size.
3. Separate hard requirements from preferences such as native batching. An unmet
   requirement rejects before network submission.
4. Add a pure diagnostic evaluator returning eligibility and structured reasons
   per candidate. Start with diagnostics and explicit route groups, not
   autonomous cost optimization.
5. Respect explicit routes. Capability-aware routing must not escape tenant,
   region, or account constraints.
6. Treat provider-hosted templates as destination-bound unless explicit
   equivalent mappings exist.
7. Clarify registry semantics: routes resolve at layer construction. Defer live
   reconfiguration.
8. Persist immutable attachment references or checksums. Refetching a mutable
   URL is not a content snapshot.

Proposed diagnostic surface, subject to implementation review:

```ts
const decision = yield* Routing.explain(prepared, {
  candidates: [primary, secondary],
  prefer: ["nativeBatch"]
})
```

Acceptance: unsuitable candidates produce actionable reasons; fallback
revalidates targets; explanations do not send or expose secrets; static routing
stays compatible.

## 10. Workstream E: events, workflows, suppression, and cancellation

Priority: P1; depends on C.

Event model:

- Normalize event identity with provider, account/destination, and provider event
  ID; deduplicate atomically in SQL.
- Resolve tenant and delivery through verified receipt correlation.
- Store provider occurrence time and local ingestion time.
- Define deterministic handling of duplicate and out-of-order events.
- Separate submission state from recipient outcome. Retain recipient-level
  events where providers expose them.
- Define a projection table for allowed transitions. Preserve contradictory
  evidence in history.
- Add provider signature helpers incrementally, beginning with fully tested
  adapters. Verify raw bytes and replay rules.

Workflow boundary:

- Keep durable delays and business coordination in workflows; keep dispatch
  attempts in the worker.
- Replace first-event completion with explicit event type, delivery/recipient
  scope, deadline, and timeout outcome.
- Check stored matching events before waiting and cover the check/wait race.
- Include logical purpose in wait identity.
- Document that `WorkflowEngine.layerMemory` is development-only and demonstrate
  a persistent deployment.

Suppression and cancellation:

- Production assembly requires an explicit suppression mode: enforced store or
  deliberate disabled mode.
- Check suppression at admission and immediately before dispatch.
- Define whole-message rejection versus recipient filtering explicitly.
- Apply verified hard-bounce/complaint suppression; keep temporary bounces
  distinct.
- Define cancellation outcomes: canceled-before-dispatch,
  cancellation-requested, already-submitted.
- Redrive requires explicit duplicate-risk acknowledgment in the audit trail.

Acceptance: unrelated events cannot satisfy a delivered wait; event-before-wait
and check/wait races work; cross-account events cannot alter a delivery; newly
suppressed recipients are blocked at dispatch; cancellation races yield truthful
outcomes.

## 11. Workstream F: developer experience and production assembly

Priority: P1 for documentation, P2 for convenience API.

Changes:

1. Rewrite README around direct, resilient, and durable adoption. Lead with the
   shortest complete Mock example and one real provider example.
2. Reuse `Email.layerTransport` for one provider. Introduce static routes versus
   registry assembly only when a second route is needed.
3. Document provider clients as escape hatches that share transport resources.
4. Publish an operation glossary: prepare, admit, attempt, accepted, delivered,
   uncertain, retry, redrive, cancel.
5. Replace startup defects for user configuration with typed configuration
   errors where practical.
6. Add a complete PostgreSQL service example with migrations, admission, worker,
   publisher, reconciler, shutdown, status lookup, and event verification.
7. Only after that example stabilizes, extract a thin optional runtime assembly
   helper that exposes services and worker health, accepts existing layers, and
   releases fibers/connections cleanly. Do not hide listeners or background
   processes in `Email.layer`.
8. Separate readiness from liveness. Shutdown stops new admissions and accounts
   for in-flight attempts.
9. Clarify HTTP versus SMTP admission semantics. SMTP acceptance acknowledges
   durable responsibility; downstream uncertainty remains visible.

Acceptance: examples compile in CI; direct sending imports no SQL/server
modules; graceful shutdown is exercised; production example survives restart;
configuration failures are actionable and typed.

## 12. Workstream G: operational visibility and retention

Priority: P1 for diagnostics, P2 for expanded tooling.

- Add bounded tenant-scoped queries by status, time, destination, and delivery
  ID. Keep old accessors temporarily but stop using all-row scans internally.
- Expose attempt history, route choice, retry reason, next attempt time, provider
  events, and redrive actor/reason through authenticated diagnostics.
- Add Effect metrics/spans for admission, physical attempts, acceptance,
  uncertainty, retry, queue lag, outbox lag, event lag, and reconciliation age.
- Keep metric dimensions bounded. Delivery IDs and addresses belong only in
  access-controlled traces/records.
- Add reconciliation through provider retrieval only where meaningful. Lack of a
  receipt may require manual resolution.
- Define retention separately for content, attempts, provider events,
  idempotency metadata, cancellation tombstones, and audit history.
- Make content deletion explicit while retaining minimal operational metadata.

Acceptance: an operator can explain a failed or uncertain delivery without
database surgery; retention cannot remove a live attachment; redrive is
attributable; diagnostics are tenant-scoped and paginated.

## 13. Workstream H: provider quality, SMTP, and packaging

Priority: P1 quality foundation; P2 extended coverage.

- Create a reusable provider contract suite for payload mapping, authentication,
  capability checks, certainty, idempotency, batch indexing, and receipt routing.
- Use local fixtures and servers by default; opt in to sandbox tests for real
  providers.
- Label support by evidence: contract-tested, sandbox-tested, or
  production-reported.
- Keep SMTP a focused submission gateway. Prioritize bounded sessions,
  authentication throttling, TLS, MIME folding/encoding, attachment filenames,
  and common-client interoperability.
- Add slow-client and protocol-fuzz tests. Full MTA delivery, MX scheduling, and
  bounce generation remain out of scope.
- Review the pinned Effect dependency strategy before release. Validate
  compatible ranges, single-runtime composition, package-manager behavior,
  installed tarball imports, and target runtimes.
- Keep Node/SMTP bindings behind explicit subpaths.

## 14. PR sequence

| PR | Deliverable | Depends on | Exit evidence |
| --- | --- | --- | --- |
| 1 | Baseline inventory, lifecycle ADR, updated docs status | None | Current API/guarantee matrix with source references |
| 2 | Conservative HTTP certainty + shared retry decisions | 1 | Response-loss and retry classification tests |
| 3 | Native-batch policy preservation | 2 | Partial-batch and composition contract tests |
| 4 | Pure delivery transitions + local SQL execution | 1 | Memory/SQL parity and interleaving tests |
| 5 | Atomic claims, creation, tenant identity migration | 4 | Concurrent PostgreSQL and migration tests |
| 6 | Outbox/reconciler queries + attempt history | 2, 5 | Crash-window and stale-attempt tests |
| 7 | Shared preparation + capability diagnostics | 3 | Route requirements and snapshot tests |
| 8 | Correlated events + deterministic projection | 5 | Duplicate/out-of-order/cross-account tests |
| 9 | Event predicates, cancellation, suppression | 6, 8 | Restart/race tests and documented outcomes |
| 10 | Complete production assembly + three-level docs | 6, 9 | Executable examples and shutdown tests |
| 11 | Operator queries, metrics, retention | 6, 8 | Bounded queries, redaction, reference-safe pruning |
| 12 | Provider/SMTP conformance + release qualification | 3, 10, 11 | Published support matrix and tarball smoke tests |

PRs 2-4 are complete. PR 5 is partially complete: atomic claims, atomic
creation, tenant storage/indexing, and embedded attempt history are done;
composite tenant keys and normalized attempt storage remain. PR 6 bounded query work is complete.

## 15. Compatibility and migration

- Preserve `Email.send`, static routes, existing provider `make` functions, and
  explicit subpaths where possible.
- Introduce new data fields with versioned schemas and readers that understand
  the previous stored format during transition.
- Treat tenant identity changes as a database and API migration. Supply a
  dry-run report for missing mappings and duplicate identities.
- Treat tightened certainty handling as a visible behavioral change: fewer
  automatic retries may produce more uncertain outcomes.
- Preserve original batch indexes through every internal split.
- Make schema upgrades explicit and dialect-aware.
- Document rolling-upgrade compatibility for queue jobs and stored records.
- Provide rollback boundaries. A binary rollback is unsafe after an incompatible
  migration unless a reverse migration is tested.

## 16. Verification and release gates

Run typecheck, test, build, smoke, and package dry-run checks. Extend CI beyond
the basic PostgreSQL rollback test with meaningful concurrent workers and fault
injection.

| Failure window | Required result |
| --- | --- |
| Before intent commit | No acknowledged durable admission |
| After commit, before queue publication | Publisher recovers the intent |
| Duplicate queue delivery | No second active claim |
| Provider accepts, response is lost | Uncertain; no unsafe automatic replay |
| Provider accepts, receipt persistence fails | Reconciliation retains unresolved work |
| Worker stops during network request | Recovery does not infer rejection from process death |
| Cancellation races with dispatch | Outcome describes whether dispatch was prevented |
| Event arrives before wait or receipt persistence | Correlate/reconcile without loss or incorrect completion |
| Suppression changes while queued | Dispatch enforcement applies the documented policy |
| Retention races with active work | Referenced content remains available |

Use test clocks and deterministic barriers for race tests, not sleeps. Add
property-based transition sequences if they discover invalid states. Load tests
should report latency, queue depth, SQL work, and uncertainty alongside
throughput.

Reliability-beta gate: Workstreams A/B/C invariants pass, no unresolved
high-impact finding in exercised paths, and limitations are documented. Stable
release additionally requires production assembly validation, supported
migration paths, event/suppression behavior, retention safety, and a provider
support matrix. A passing test count alone is not the release criterion.

## 17. Deliberate deferrals

Defer new provider adapters, automatic cheapest-provider routing, live route
hot-swapping, a hosted dashboard, a custom template language, marketing campaign
automation, full MTA behavior, and claims of universal exactly-once delivery.

## 18. Source map

- `README.md`
- `docs/improvement-plan.md` - composition history
- `docs/baseline-inventory.md` - current API and guarantee matrix
- `docs/adr/0001-delivery-lifecycle.md` - lifecycle decision
- `docs/review-findings.md`
- `docs/review-plan.md`
- `docs/runtime-matrix.md`
- `docs/driver-parity.md`
- `src/EmailTransport.ts`
- `src/Email.ts`
- `src/EmailError.ts`
- `src/DeliveryStore.ts`
- `src/DeliveryStoreSql.ts`
- `src/SubmissionAdmission.ts`
- `src/queue/Submissions.ts`
- `src/workflow/Submissions.ts`
- `src/providers/`
- `migrations/`
