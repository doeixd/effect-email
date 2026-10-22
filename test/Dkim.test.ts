import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { deliveryId } from "../src/Ids"
import { prepare } from "../src/Message"
import * as Dkim from "../src/smtp/Dkim"
import { buildMime } from "../src/smtp/Mime"

const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048
})

const privateKey = keyPair.privateKey.export({
  type: "pkcs8",
  format: "pem"
}) as string

const message = Effect.gen(function* () {
  const prepared = yield* prepare({
    from: "sender@example.com",
    to: "user@example.com",
    subject: "Signed",
    text: "Signed body",
    deliveryId: deliveryId("dlv_dkim_1")
  })
  return yield* buildMime(prepared, {
    date: new Date("2026-01-01T00:00:00.000Z")
  })
})

describe("DKIM signing", () => {
  it.effect("prepends a relaxed RSA-SHA256 signature", () =>
    Effect.gen(function* () {
      const unsigned = yield* message
      const signed = yield* Dkim.sign(unsigned, {
        domain: "example.com",
        selector: "test",
        privateKey,
        timestamp: 1_700_000_000
      })
      const text = new TextDecoder().decode(signed)
      const original = new TextDecoder().decode(unsigned)

      assert.isTrue(text.startsWith("DKIM-Signature: "))
      assert.include(text, "a=rsa-sha256")
      assert.include(text, "c=relaxed/relaxed")
      assert.include(text, "d=example.com")
      assert.include(text, "s=test")
      assert.include(text, "t=1700000000")
      assert.include(text, "h=from:to:subject:date:message-id:mime-version:content-type")
      assert.include(text, "bh=")
      assert.match(text, /b=[A-Za-z0-9+/=]{100,}/)
      assert.isTrue(text.includes(original))
    }))

  it.effect("reports an invalid private key", () =>
    Effect.gen(function* () {
      const unsigned = yield* message
      const result = yield* Effect.result(
        Dkim.sign(unsigned, {
          domain: "example.com",
          selector: "test",
          privateKey: "not a key"
        })
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "DkimSigningError"
      )
    }))
})
