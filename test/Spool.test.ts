import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import * as Spool from "../src/Spool"

const bytes = new TextEncoder().encode("hello spool")

describe("Spool", () => {
  it.effect("stores content-addressed bytes with metadata", () =>
    Effect.gen(function* () {
      const spool = yield* Spool.Spool
      const reference = yield* spool.put(bytes, {
        contentType: "text/plain"
      })
      const stored = yield* spool.get(reference)

      assert.match(reference.key, /^sha256:[0-9a-f]{64}$/)
      assert.strictEqual(reference.sha256?.length, 64)
      assert.strictEqual(reference.size, bytes.byteLength)
      assert.strictEqual(reference.contentType, "text/plain")
      assert.deepStrictEqual([...stored], [...bytes])
    }).pipe(Effect.provide(Spool.layerMemory)))

  it.effect("deduplicates identical content and isolates buffers", () =>
    Effect.gen(function* () {
      const spool = yield* Spool.Spool
      const first = yield* spool.put(bytes)
      const second = yield* spool.put(bytes)
      const stored = yield* spool.get(first)
      stored[0] = 0

      const again = yield* spool.get(first)

      assert.strictEqual(first.key, second.key)
      assert.deepStrictEqual([...again], [...bytes])
    }).pipe(Effect.provide(Spool.layerMemory)))

  it.effect("prunes content older than a cutoff", () =>
    Effect.gen(function* () {
      const spool = yield* Spool.Spool
      const reference = yield* spool.put(bytes)
      const cutoff = DateTime.makeUnsafe(
        new Date(Date.now() + 60_000)
      )
      const removed = yield* spool.prune(cutoff)

      assert.strictEqual(removed, 1)
      assert.isFalse(yield* spool.has(reference))
    }).pipe(Effect.provide(Spool.layerMemory)))

  it.effect("deletes content and rejects a missing lookup", () =>
    Effect.gen(function* () {
      const spool = yield* Spool.Spool
      const reference = yield* spool.put(bytes)
      yield* spool.delete(reference)

      const exists = yield* spool.has(reference)
      const missing = yield* Effect.result(spool.get(reference))

      assert.isFalse(exists)
      assert.strictEqual(
        missing._tag === "Failure" && missing.failure._tag,
        "StoreUnavailable"
      )
    }).pipe(Effect.provide(Spool.layerMemory)))
})
