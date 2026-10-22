import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Ref,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { StoreUnavailable } from "./EmailError"
import type { TenantId } from "./Ids"
import { TenantId as TenantIdSchema } from "./Ids"

export const SuppressionInput = Schema.Struct({
  tenantId: TenantIdSchema,
  recipient: Schema.NonEmptyString,
  reason: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type SuppressionInput = typeof SuppressionInput.Type

export interface SuppressionRecord {
  readonly tenantId: TenantId
  readonly recipient: string
  readonly reason?: string
  readonly createdAt: DateTime.Utc
  readonly expiresAt?: DateTime.Utc
}

export interface SuppressionStoreShape {
  readonly suppress: (
    input: SuppressionInput
  ) => Effect.Effect<void, StoreUnavailable>
  readonly remove: (
    tenantId: TenantId,
    recipient: string
  ) => Effect.Effect<void, StoreUnavailable>
  readonly isSuppressed: (
    tenantId: TenantId,
    recipient: string,
    at?: DateTime.Utc
  ) => Effect.Effect<Option.Option<SuppressionRecord>, StoreUnavailable>
  readonly suppressed: (
    tenantId: TenantId,
    recipients: ReadonlyArray<string>,
    at?: DateTime.Utc
  ) => Effect.Effect<ReadonlyArray<string>, StoreUnavailable>
  readonly list: (
    tenantId: TenantId
  ) => Effect.Effect<ReadonlyArray<SuppressionRecord>, StoreUnavailable>
  readonly prune: (
    at: DateTime.Utc
  ) => Effect.Effect<number, StoreUnavailable>
}

export class SuppressionStore extends Context.Service<
  SuppressionStore,
  SuppressionStoreShape
>()("@effect-email/SuppressionStore") {}

export const normalizeRecipient = (recipient: string): string => {
  const angled = recipient.lastIndexOf("<")
  const closed = recipient.lastIndexOf(">")
  const address =
    angled >= 0 && closed > angled
      ? recipient.slice(angled + 1, closed)
      : recipient
  return address.trim().toLowerCase()
}

const active = (
  record: SuppressionRecord,
  at: DateTime.Utc
): boolean =>
  record.expiresAt === undefined ||
  DateTime.toEpochMillis(record.expiresAt) > DateTime.toEpochMillis(at)

const normalizeError = (cause: unknown): StoreUnavailable =>
  cause instanceof StoreUnavailable ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause)
    ? (cause as StoreUnavailable)
    : new StoreUnavailable({
        message: "suppression store operation failed",
        cause
      })

export const layerMemory: Layer.Layer<SuppressionStore> = Layer.effect(
  SuppressionStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<
      ReadonlyMap<string, SuppressionRecord>
    >(new Map())

    const key = (tenantId: TenantId, recipient: string) =>
      `${tenantId}\u0000${normalizeRecipient(recipient)}`

    const suppress: SuppressionStoreShape["suppress"] = (input) =>
      Effect.gen(function* () {
        const createdAt = yield* DateTime.now
        const record: SuppressionRecord = {
          tenantId: input.tenantId,
          recipient: normalizeRecipient(input.recipient),
          createdAt,
          ...(input.reason === undefined
            ? {}
            : { reason: input.reason }),
          ...(input.expiresAt === undefined
            ? {}
            : { expiresAt: input.expiresAt })
        }
        yield* Ref.update(state, (current) => {
          const next = new Map(current)
          next.set(key(input.tenantId, record.recipient), record)
          return next
        })
      })

    const remove: SuppressionStoreShape["remove"] = (
      tenantId,
      recipient
    ) =>
      Ref.update(state, (current) => {
        const next = new Map(current)
        next.delete(key(tenantId, recipient))
        return next
      })

    const list: SuppressionStoreShape["list"] = (tenantId) =>
      Effect.map(Ref.get(state), (current) =>
        [...current.values()].filter(
          (record) => record.tenantId === tenantId
        )
      )

    const isSuppressed: SuppressionStoreShape["isSuppressed"] = (
      tenantId,
      recipient,
      at
    ) =>
      Effect.gen(function* () {
        const now = at ?? (yield* DateTime.now)
        const record = (yield* Ref.get(state)).get(
          key(tenantId, recipient)
        )
        return record !== undefined && active(record, now)
          ? Option.some(record)
          : Option.none()
      })

    const suppressed: SuppressionStoreShape["suppressed"] = (
      tenantId,
      recipients,
      at
    ) =>
      Effect.gen(function* () {
        const now = at ?? (yield* DateTime.now)
        const current = yield* Ref.get(state)
        const blocked = new Set<string>()
        for (const recipient of recipients) {
          const normalized = normalizeRecipient(recipient)
          const record = current.get(key(tenantId, normalized))
          if (record !== undefined && active(record, now)) {
            blocked.add(normalized)
          }
        }
        return [...blocked]
      })

    const prune: SuppressionStoreShape["prune"] = (at) =>
      Ref.modify(state, (current) => {
        const cutoff = DateTime.toEpochMillis(at)
        const next = new Map<string, SuppressionRecord>()
        let removed = 0
        for (const [entryKey, record] of current) {
          if (
            record.expiresAt !== undefined &&
            DateTime.toEpochMillis(record.expiresAt) <= cutoff
          ) {
            removed += 1
          } else {
            next.set(entryKey, record)
          }
        }
        return [removed, next]
      })

    return {
      suppress,
      remove,
      isSuppressed,
      suppressed,
      list,
      prune
    }
  })
)

export interface SuppressionStoreSqlOptions {
  readonly tableName?: string
}

export const layerSql = (
  options: SuppressionStoreSqlOptions = {}
): Layer.Layer<SuppressionStore, SqlError, SqlClient.SqlClient> =>
  Layer.effect(
    SuppressionStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const table = options.tableName ?? "effect_email_suppressions"

      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(
        table
      )} (tenant_id TEXT NOT NULL, recipient TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (tenant_id, recipient))`
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(
        `${table}_expires`
      )} ON ${sql(table)} (expires_at)`

      type Row = {
        readonly tenant_id: string
        readonly recipient: string
        readonly reason: string | null
        readonly created_at: string
        readonly expires_at: string | null
      }

      const recordOf = (row: Row): SuppressionRecord => ({
        tenantId: row.tenant_id as TenantId,
        recipient: row.recipient,
        ...(row.reason === null ? {} : { reason: row.reason }),
        createdAt: DateTime.makeUnsafe(new Date(row.created_at)),
        ...(row.expires_at === null
          ? {}
          : {
              expiresAt: DateTime.makeUnsafe(new Date(row.expires_at))
            })
      })

      const list: SuppressionStoreShape["list"] = (tenantId) =>
        sql<Row>`SELECT tenant_id, recipient, reason, created_at, expires_at FROM ${sql(
          table
        )} WHERE tenant_id = ${tenantId}`.pipe(
          Effect.map((rows) => rows.map(recordOf)),
          Effect.mapError(normalizeError)
        )

      const suppress: SuppressionStoreShape["suppress"] = (input) =>
        Effect.gen(function* () {
          const createdAt = yield* DateTime.now
          yield* sql`INSERT INTO ${sql(
            table
          )} (tenant_id, recipient, reason, created_at, expires_at) VALUES (${
            input.tenantId
          }, ${normalizeRecipient(input.recipient)}, ${
            input.reason ?? null
          }, ${DateTime.formatIso(createdAt)}, ${
            input.expiresAt === undefined
              ? null
              : DateTime.formatIso(input.expiresAt)
          }) ON CONFLICT(tenant_id, recipient) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, expires_at = excluded.expires_at`
        }).pipe(Effect.mapError(normalizeError))

      const remove: SuppressionStoreShape["remove"] = (
        tenantId,
        recipient
      ) =>
        sql`DELETE FROM ${sql(
          table
        )} WHERE tenant_id = ${tenantId} AND recipient = ${normalizeRecipient(
          recipient
        )}`.pipe(Effect.asVoid, Effect.mapError(normalizeError))

      const isSuppressed: SuppressionStoreShape["isSuppressed"] = (
        tenantId,
        recipient,
        at
      ) =>
        Effect.gen(function* () {
          const now = at ?? (yield* DateTime.now)
          const normalized = normalizeRecipient(recipient)
          const rows = yield* sql<Row>`SELECT tenant_id, recipient, reason, created_at, expires_at FROM ${sql(
            table
          )} WHERE tenant_id = ${tenantId} AND recipient = ${normalized} LIMIT 1`.pipe(
            Effect.mapError(normalizeError)
          )
          const record = rows[0] === undefined ? undefined : recordOf(rows[0])
          return record !== undefined && active(record, now)
            ? Option.some(record)
            : Option.none()
        })

      const suppressed: SuppressionStoreShape["suppressed"] = (
        tenantId,
        recipients,
        at
      ) =>
        Effect.gen(function* () {
          const now = at ?? (yield* DateTime.now)
          const normalized = [
            ...new Set(recipients.map(normalizeRecipient))
          ]
          if (normalized.length === 0) {
            return []
          }
          const rows = yield* sql<Row>`SELECT tenant_id, recipient, reason, created_at, expires_at FROM ${sql(
            table
          )} WHERE tenant_id = ${tenantId} AND ${sql.in(
            "recipient",
            normalized
          )}`.pipe(Effect.mapError(normalizeError))
          return rows
            .map(recordOf)
            .filter((record) => active(record, now))
            .map((record) => record.recipient)
        })

      const prune: SuppressionStoreShape["prune"] = (at) =>
        sql<{ readonly recipient: string }>`DELETE FROM ${sql(
          table
        )} WHERE expires_at IS NOT NULL AND expires_at <= ${DateTime.formatIso(
          at
        )} RETURNING recipient`.pipe(
          Effect.map((rows) => rows.length),
          Effect.mapError(normalizeError)
        )

      return {
        suppress,
        remove,
        isSuppressed,
        suppressed,
        list,
        prune
      }
    })
  )
