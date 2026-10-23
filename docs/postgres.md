# PostgreSQL deployment notes

## Delivery store

`DeliveryStoreSql.layerSql` requires an `effect/sql` `SqlClient`. It stores one
JSON payload per delivery intent and one per provider event, with denormalized
`tenant_id`, `status`, `updated_at`, `queued_at`, `claim_expires_at`,
`provider_message_id`, `event_type`, and `occurred_at` columns for indexed
operational queries. Run
`migrations/0001_delivery_store.sql` before starting the service. Existing
installations created before these columns were added should run
`migrations/0002_delivery_store_columns.sql`, which backfills them from the
stored JSON. Run `migrations/0004_cancellations.sql` for durable pre-admission
cancellation tombstones, `migrations/0005_delivery_tenant.sql` for tenant
storage/backfill, `migrations/0006_delivery_query_indexes.sql` for bounded
outbox and stale-claim queries, and `migrations/0007_event_correlation.sql` for
provider-message correlation. Attempt history is retained inside the intent
JSON payload; receipt and attempt tables remain a future normalization step.

```ts
import { PgClient } from "@effect/sql-pg"
import { DeliveryStoreSql } from "@doeixd/effect-email/DeliveryStoreSql"

const deliveryStore = DeliveryStoreSql.layerSql().pipe(
  Layer.provide(PgClient.layer({ url }))
)
```

The package does not depend on a PostgreSQL driver; provide the matching
`@effect/sql` driver and `SqlClient` layer in the application. The gated
integration test `test/Postgres.integration.test.ts` verifies transactional
intent/queue rollback when `DATABASE_URL` is set.

## Suppressions

`Suppression.layerSql` stores tenant-scoped recipient suppressions in
`effect_email_suppressions`. Run `migrations/0003_suppressions.sql` when
provisioning explicitly; the layer also creates the table idempotently. Pass the
layer alongside `SubmissionAdmission` to enable admission-time checks.

## Submission queue

`Submissions.layerFactorySql` provides `PersistedQueue` over `effect/sql`.
`PersistedQueue.layerStoreSql` owns its queue table and lock/poll settings; pass
its options through `layerFactorySql`. Run the queue store and delivery store
against the same database when application transactions must cover both, and
verify that queue offers participate in the application transaction before
claiming atomic enqueue. Otherwise run `Submissions.runPublisher` against
unqueued intents as the outbox recovery path.

## Remaining hardening

- Normalized intent, attempt, receipt, and provider-event tables.
- PostgreSQL-specific verification of queue-offer transaction participation is
  covered by `test/Postgres.integration.test.ts` and was verified against
  PostgreSQL 16; wire it into CI with a PostgreSQL service container.
- Scheduled retention jobs around `DeliveryStore.prune` and `Spool.prune`.
- Concurrent-worker load tests.
