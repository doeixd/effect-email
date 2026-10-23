import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option
} from "effect"
import { Base64 } from "effect/encoding"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type {
  DeliveryEvent,
  DeliveryIntent,
  DeliveryStoreShape,
  DeliveryStoreSnapshot
} from "./DeliveryStore"
import type { DeliveryId } from "./Ids"
import {
  DeliveryStore,
  deliveryStatusForEvent,
  layerMemory
} from "./DeliveryStore"
import { StoreUnavailable } from "./EmailError"

export interface DeliveryStoreSqlOptions {
  readonly tableName?: string
}

const BYTES = "__effect_email_bytes__"
const DATETIME = "__effect_email_datetime__"

const encode = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return { [BYTES]: Base64.encode(value) }
  }
  if (DateTime.isDateTime(value)) {
    return { [DATETIME]: DateTime.formatIso(value) }
  }
  if (Array.isArray(value)) {
    return value.map(encode)
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encode(entry)])
    )
  }
  return value
}

const decode = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decode)
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record[BYTES] === "string") {
      const decoded = Base64.decode(record[BYTES])
      return decoded._tag === "Success"
        ? decoded.success
        : new Uint8Array()
    }
    if (typeof record[DATETIME] === "string") {
      return DateTime.makeUnsafe(new Date(record[DATETIME]))
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, decode(entry)])
    )
  }
  return value
}

const normalizeError = (cause: unknown): StoreUnavailable =>
  cause instanceof StoreUnavailable ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause)
    ? (cause as StoreUnavailable)
    : new StoreUnavailable({
        message: "SQL delivery store operation failed",
        cause
      })

export const layerSql = (
  options: DeliveryStoreSqlOptions = {}
): Layer.Layer<DeliveryStore, SqlError, SqlClient.SqlClient> =>
  Layer.effect(
    DeliveryStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const prefix = options.tableName ?? "effect_email_delivery"
      const intents = `${prefix}_intents`
      const events = `${prefix}_events`
      const cancellations = `${prefix}_cancellations`

      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(
        intents
      )} (delivery_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, queued_at TEXT, data TEXT NOT NULL)`
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(
        events
      )} (event_id TEXT PRIMARY KEY, delivery_id TEXT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL)`
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(
        cancellations
      )} (delivery_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${intents}_status`
      )} ON ${sql(intents)} (status)`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${intents}_updated`
      )} ON ${sql(intents)} (updated_at)`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${events}_delivery`
      )} ON ${sql(events)} (delivery_id)`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${events}_type`
      )} ON ${sql(events)} (event_type)`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${events}_occurred`
      )} ON ${sql(events)} (occurred_at)`

      const memoryStore = Effect.scoped(
        Effect.map(
          Layer.build(layerMemory),
          (context) => Context.get(context, DeliveryStore)
        )
      )

      const allIntents = Effect.map(
        sql<{ readonly data: string }>`SELECT data FROM ${sql(
          intents
        )}`,
        (rows) =>
          rows.map(
            (row) => decode(JSON.parse(row.data)) as DeliveryIntent
          )
      )

      const intentsByStatus = (status: string) =>
        Effect.map(
          sql<{ readonly data: string }>`SELECT data FROM ${sql(
            intents
          )} WHERE status = ${status}`,
          (rows) =>
            rows.map(
              (row) => decode(JSON.parse(row.data)) as DeliveryIntent
            )
        )

      const allEvents = Effect.map(
        sql<{ readonly data: string }>`SELECT data FROM ${sql(
          events
        )}`,
        (rows) =>
          rows.map(
            (row) => decode(JSON.parse(row.data)) as DeliveryEvent
          )
      )

      const saveIntent = (intent: DeliveryIntent) =>
        sql`INSERT INTO ${sql(
          intents
        )} (delivery_id, status, updated_at, queued_at, data) VALUES (${
          intent.deliveryId
        }, ${intent.status}, ${DateTime.formatIso(
          intent.updatedAt
        )}, ${
          intent.queuedAt === undefined
            ? null
            : DateTime.formatIso(intent.queuedAt)
        }, ${JSON.stringify(
          encode(intent)
        )}) ON CONFLICT(delivery_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, queued_at = excluded.queued_at, data = excluded.data`

      const saveCancellation = (deliveryId: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* sql`INSERT INTO ${sql(
            cancellations
          )} (delivery_id, created_at) VALUES (${deliveryId}, ${DateTime.formatIso(
            now
          )}) ON CONFLICT(delivery_id) DO NOTHING`
        })

      const saveEvent = (event: DeliveryEvent) =>
        sql`INSERT INTO ${sql(
          events
        )} (event_id, delivery_id, event_type, occurred_at, data) VALUES (${
          event.id
        }, ${event.deliveryId ?? null}, ${event.type}, ${DateTime.formatIso(
          event.occurredAt
        )}, ${JSON.stringify(encode(event))})`

      const selectIntent = (deliveryId: string) =>
        sql.onDialectOrElse({
          orElse: () =>
            sql<{ readonly data: string }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId}`,
          sqlite: () =>
            sql<{ readonly data: string }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId}`,
          pg: () =>
            sql<{ readonly data: string }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId} FOR UPDATE`,
          mysql: () =>
            sql<{ readonly data: string }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId} FOR UPDATE`,
          mssql: () =>
            sql<{ readonly data: string }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId} WITH (UPDLOCK, ROWLOCK)`
        })

      const runIntent = <A, E>(
        deliveryId: string,
        persist: boolean,
        run: (store: DeliveryStoreShape) => Effect.Effect<A, E>,
        clearCancellation = false
      ): Effect.Effect<A, E | StoreUnavailable> =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* selectIntent(deliveryId)
              const memory = yield* memoryStore
              const existing =
                rows[0] === undefined
                  ? undefined
                  : (decode(JSON.parse(rows[0].data)) as DeliveryIntent)
              const canceled = yield* sql<{
                readonly delivery_id: string
              }>`SELECT delivery_id FROM ${sql(
                cancellations
              )} WHERE delivery_id = ${deliveryId}`
              yield* memory.restore({
                intents: existing === undefined ? [] : [existing],
                events: [],
                cancellations:
                  canceled.length === 0
                    ? []
                    : [deliveryId as DeliveryId]
              })
              const result = yield* Effect.result(run(memory))
              if (result._tag === "Success" && persist) {
                const snapshot = yield* memory.snapshot
                const next = snapshot.intents[0]
                if (next !== undefined) {
                  yield* saveIntent(next)
                }
              }
              if (result._tag === "Success" && clearCancellation) {
                yield* sql`DELETE FROM ${sql(
                  cancellations
                )} WHERE delivery_id = ${deliveryId}`
              }
              return result
            })
          )
          .pipe(
            Effect.flatMap((result) =>
              result._tag === "Failure"
                ? Effect.fail(result.failure)
                : Effect.succeed(result.success)
            ),
            Effect.mapError(normalizeError)
          )

      return {
        createIntent: (input) =>
          runIntent(input.deliveryId ?? "", true, (memory) =>
            memory.createIntent(input)
          ),
        get: (deliveryId) =>
          sql<{ readonly data: string }>`SELECT data FROM ${sql(
            intents
          )} WHERE delivery_id = ${deliveryId}`.pipe(
            Effect.map((rows) =>
              Option.map(
                Option.fromNullishOr(rows[0]),
                (row) => decode(JSON.parse(row.data)) as DeliveryIntent
              )
            ),
            Effect.mapError(normalizeError)
          ),
        beginAttempt: (deliveryId, generation) =>
          runIntent(deliveryId, true, (memory) =>
            memory.beginAttempt(deliveryId, generation)
          ),
        recordAccepted: (deliveryId, generation, receipt) =>
          runIntent(deliveryId, true, (memory) =>
            memory.recordAccepted(deliveryId, generation, receipt)
          ),
        recordRejected: (deliveryId, generation, error) =>
          runIntent(deliveryId, true, (memory) =>
            memory.recordRejected(deliveryId, generation, error)
          ),
        recordUncertain: (deliveryId, generation, error) =>
          runIntent(deliveryId, true, (memory) =>
            memory.recordUncertain(deliveryId, generation, error)
          ),
        recordFailed: (deliveryId, generation, error) =>
          runIntent(deliveryId, true, (memory) =>
            memory.recordFailed(deliveryId, generation, error)
          ),
        recordDeferred: (deliveryId, generation, error, delay) =>
          runIntent(deliveryId, true, (memory) =>
            memory.recordDeferred(
              deliveryId,
              generation,
              error,
              delay
            )
          ),
        markQueued: (deliveryId, generation) =>
          runIntent(deliveryId, true, (memory) =>
            memory.markQueued(deliveryId, generation)
          ),
        requestCancellation: (deliveryId) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const memory = yield* memoryStore
                const rows = yield* selectIntent(deliveryId)
                const existing =
                  rows[0] === undefined
                    ? undefined
                    : (decode(JSON.parse(rows[0].data)) as DeliveryIntent)
                if (existing !== undefined) {
                  yield* memory.restore({
                    intents: [existing],
                    events: [],
                    cancellations: []
                  })
                  yield* memory.requestCancellation(deliveryId)
                  const snapshot = yield* memory.snapshot
                  const next = snapshot.intents[0]
                  if (next !== undefined) {
                    yield* saveIntent(next)
                  }
                }
                yield* saveCancellation(deliveryId)
              })
            )
            .pipe(Effect.mapError(normalizeError)),
        isCancellationRequested: (deliveryId) =>
          Effect.gen(function* () {
            const canceled = yield* sql<{
              readonly delivery_id: string
            }>`SELECT delivery_id FROM ${sql(
              cancellations
            )} WHERE delivery_id = ${deliveryId}`.pipe(
              Effect.mapError(normalizeError)
            )
            if (canceled.length > 0) {
              return true
            }
            const rows = yield* sql<{
              readonly data: string
            }>`SELECT data FROM ${sql(
              intents
            )} WHERE delivery_id = ${deliveryId}`.pipe(
              Effect.mapError(normalizeError)
            )
            if (rows[0] === undefined) {
              return false
            }
            return (
              decode(JSON.parse(rows[0].data)) as DeliveryIntent
            ).cancellationRequested
          }),
        redrive: (deliveryId) =>
          runIntent(
            deliveryId,
            true,
            (memory) => memory.redrive(deliveryId),
            true
          ),
        listUncertain: intentsByStatus("uncertain").pipe(
          Effect.mapError(normalizeError)
        ),
        listPending: intentsByStatus("pending").pipe(
          Effect.mapError(normalizeError)
        ),
        listUnqueued: sql<{ readonly data: string }>`SELECT data FROM ${sql(
          intents
        )} WHERE status = ${"pending"} AND queued_at IS NULL`.pipe(
          Effect.map((rows) =>
            rows.map(
              (row) => decode(JSON.parse(row.data)) as DeliveryIntent
            )
          ),
          Effect.mapError(normalizeError)
        ),
        listFailed: intentsByStatus("failed").pipe(
          Effect.mapError(normalizeError)
        ),
        listAll: allIntents.pipe(Effect.mapError(normalizeError)),
        appendProviderEvent: (event) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{
                  readonly event_id: string
                }>`SELECT event_id FROM ${sql(
                  events
                )} WHERE event_id = ${event.id}`
                if (rows.length > 0) {
                  return false
                }
                yield* saveEvent(event)
                if (event.deliveryId !== undefined) {
                  const status = deliveryStatusForEvent(event.type)
                  if (status !== undefined) {
                    const intentRows = yield* selectIntent(
                      event.deliveryId
                    )
                    if (intentRows[0] !== undefined) {
                      const intent = decode(
                        JSON.parse(intentRows[0].data)
                      ) as DeliveryIntent
                      yield* saveIntent({
                        ...intent,
                        status,
                        updatedAt: event.occurredAt
                      })
                    }
                  }
                }
                return true
              })
            )
            .pipe(Effect.mapError(normalizeError)),
        listEvents: (deliveryId) =>
          (deliveryId === undefined
            ? allEvents
            : Effect.map(
                sql<{ readonly data: string }>`SELECT data FROM ${sql(
                  events
                )} WHERE delivery_id = ${deliveryId} ORDER BY occurred_at, event_id`,
                (rows) =>
                  rows.map(
                    (row) =>
                      decode(JSON.parse(row.data)) as DeliveryEvent
                  )
              )
          ).pipe(Effect.mapError(normalizeError)),
        prune: (options) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                let intentCount = 0
                let eventCount = 0
                if (options.intentsBefore !== undefined) {
                  const deleted = yield* sql<{
                    readonly delivery_id: string
                  }>`DELETE FROM ${sql(
                    intents
                  )} WHERE status IN (${"rejected"}, ${"failed"}, ${"canceled"}) AND updated_at < ${DateTime.formatIso(
                    options.intentsBefore
                  )} RETURNING delivery_id`
                  intentCount = deleted.length
                }
                if (options.eventsBefore !== undefined) {
                  const deleted = yield* sql<{
                    readonly event_id: string
                  }>`DELETE FROM ${sql(
                    events
                  )} WHERE occurred_at < ${DateTime.formatIso(
                    options.eventsBefore
                  )} RETURNING event_id`
                  eventCount = deleted.length
                }
                return { intents: intentCount, events: eventCount }
              })
            )
            .pipe(Effect.mapError(normalizeError)),
        snapshot: Effect.all([
          allIntents,
          allEvents,
          sql<{ readonly delivery_id: string }>`SELECT delivery_id FROM ${sql(
            cancellations
          )}`.pipe(Effect.mapError(normalizeError))
        ]).pipe(
          Effect.map(([storedIntents, storedEvents, storedCancellations]) => ({
            intents: storedIntents,
            events: storedEvents,
            cancellations: storedCancellations.map(
              (row) => row.delivery_id as DeliveryId
            )
          })),
          Effect.mapError(normalizeError)
        ),
        restore: (snapshot) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM ${sql(intents)}`
                yield* sql`DELETE FROM ${sql(events)}`
                yield* sql`DELETE FROM ${sql(cancellations)}`
                for (const intent of snapshot.intents) {
                  yield* saveIntent(intent)
                }
                for (const event of snapshot.events) {
                  yield* saveEvent(event)
                }
                for (const deliveryId of snapshot.cancellations ?? []) {
                  yield* saveCancellation(deliveryId)
                }
              })
            )
            .pipe(Effect.mapError(normalizeError))
      }
    })
  )
