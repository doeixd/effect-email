import { Context, DateTime, Effect, Layer, Ref } from "effect"
import { StoreUnavailable } from "./EmailError"
import type { BlobReference } from "./Submission"

export interface SpoolOptions {
  readonly contentType?: string
}

export interface SpoolShape {
  readonly put: (
    content: Uint8Array,
    options?: SpoolOptions
  ) => Effect.Effect<BlobReference, StoreUnavailable>
  readonly get: (
    reference: BlobReference
  ) => Effect.Effect<Uint8Array, StoreUnavailable>
  readonly has: (
    reference: BlobReference
  ) => Effect.Effect<boolean, StoreUnavailable>
  readonly delete: (
    reference: BlobReference
  ) => Effect.Effect<void, StoreUnavailable>
  readonly prune: (
    before: DateTime.Utc
  ) => Effect.Effect<number, StoreUnavailable>
}

export class Spool extends Context.Service<Spool, SpoolShape>()(
  "@effect-email/Spool"
) {}

interface SpoolEntry {
  readonly content: Uint8Array
  readonly contentType?: string
  readonly createdAt: DateTime.Utc
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const digest = (
  content: Uint8Array
): Effect.Effect<string, StoreUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      const input = new Uint8Array(content)
      const hash = await globalThis.crypto.subtle.digest(
        "SHA-256",
        input.buffer as ArrayBuffer
      )
      return toHex(new Uint8Array(hash))
    },
    catch: (cause) =>
      StoreUnavailable.new({
        message: "failed to hash spool content",
        cause
      })
  })

export const layerMemory: Layer.Layer<Spool> = Layer.effect(
  Spool,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<string, SpoolEntry>>(
      new Map()
    )

    const put: SpoolShape["put"] = (content, options = {}) =>
      Effect.gen(function* () {
        const sha256 = yield* digest(content)
        const key = `sha256:${sha256}`
        const copy = new Uint8Array(content)
        const createdAt = yield* DateTime.now
        yield* Ref.update(state, (entries) => {
          const next = new Map(entries)
          next.set(key, {
            content: copy,
            createdAt,
            ...(options.contentType === undefined
              ? {}
              : { contentType: options.contentType })
          })
          return next
        })
        return {
          key,
          size: copy.byteLength,
          sha256,
          ...(options.contentType === undefined
            ? {}
            : { contentType: options.contentType })
        }
      })

    const get: SpoolShape["get"] = (reference) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(state)).get(reference.key)
        if (entry === undefined) {
          return yield* StoreUnavailable.new({
            message: `spool object not found: ${reference.key}`
          })
        }
        return new Uint8Array(entry.content)
      })

    const has: SpoolShape["has"] = (reference) =>
      Effect.map(Ref.get(state), (entries) =>
        entries.has(reference.key)
      )

    const deleteObject: SpoolShape["delete"] = (reference) =>
      Ref.update(state, (entries) => {
        const next = new Map(entries)
        next.delete(reference.key)
        return next
      })

    const prune: SpoolShape["prune"] = (before) =>
      Ref.modify(state, (entries) => {
        const cutoff = DateTime.toEpochMillis(before)
        const next = new Map<string, SpoolEntry>()
        let removed = 0
        for (const [key, entry] of entries) {
          if (DateTime.toEpochMillis(entry.createdAt) < cutoff) {
            removed += 1
          } else {
            next.set(key, entry)
          }
        }
        return [removed, next]
      })

    return {
      put,
      get,
      has,
      delete: deleteObject,
      prune
    }
  })
)
