# Production assembly

This guide describes the durable service shape. The runnable example is
`examples/postgres-service.ts`.

## Services

```text
PgClient
  -> DeliveryStoreSql
  -> Submissions.layerFactorySql
  -> SubmissionAdmission
  -> Email (provider transport)
```

Run the publisher, worker, and reconciler through `Service.start`. It returns a
scoped handle with `health` and `shutdown`, and the three loops remain separate.
The worker consumes the supplied queue directly, including its retry policy.
Pass `admission.queue` to `Service.start`; no matching `queueName` is required:

- The publisher recovers committed-but-unqueued intents.
- The worker claims and dispatches queue items.
- The reconciler turns expired or stale in-progress claims into observable
  uncertainty.

The example accepts one message, starts the service, waits for a terminal
status, reads health, then shuts down. Closing the scope also interrupts the
loops and releases the SQL client.

## Readiness and liveness

- **Liveness:** the process event loop and SQL client are responsive.
- **Readiness:** required SQL, queue, admission, and email layers are assembled;
  worker/publisher/reconciler fibers have started.
- Do not report ready while a required layer is missing or migrations are
  unapplied.

Expose readiness only after assembly succeeds. Stop accepting new admissions
before shutting down loops, then allow in-flight attempts to finish or be
reconciled.

## Migrations

Apply migrations in order before starting the service:

```text
0001_delivery_store.sql
0002_delivery_store_columns.sql
0003_suppressions.sql
0004_cancellations.sql
0005_delivery_tenant.sql
0006_delivery_query_indexes.sql
0007_event_correlation.sql
0008_delivery_event_waits.sql
```

`layerSql` creates missing tables for development, but `CREATE TABLE IF NOT EXISTS` is not an upgrade strategy. Use the migration files for existing
databases.

## HTTP and SMTP admission

- HTTP admission returns after the intent is committed. Queue publication is
  recoverable by the publisher.
- SMTP acceptance acknowledges durable responsibility, not recipient delivery.
- Provider uncertainty remains visible in status and diagnostics; it is not
  reported as success.

## Run the example

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/effect_email \
  bun examples/postgres-service.ts
```

The example uses the Mock provider so it does not require provider credentials.
Use `Email.layerValidated` for typed configuration failures when assembling the
route layer. Replace the Mock route with a provider transport for real delivery.
