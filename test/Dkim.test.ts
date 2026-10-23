import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { createHash, createVerify, generateKeyPairSync } from "node:crypto"
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

// Verify the wire signature using RFC 6376 ordering, independently of the signer.
const verify = (signed: Uint8Array) => {
  const wire = Buffer.from(signed).toString("latin1")
  const separator = wire.indexOf("\r\n\r\n")
  const headers = wire.slice(0, separator).replace(/\r\n[ \t]+/g, " ").split("\r\n")
  const signature = headers[0]!
  const tags = new Map(signature.slice(signature.indexOf(":") + 1).split(";").map((tag) => {
    const index = tag.indexOf("=")
    return [tag.slice(0, index).trim(), tag.slice(index + 1).trim()]
  }))
  const canonical = (header: string) => {
    const colon = header.indexOf(":")
    return header.slice(0, colon).toLowerCase() + ":" +
      header.slice(colon + 1).replace(/[ \t]+/g, " ").trim()
  }
  const remaining = headers.slice(1)
  const selected = tags.get("h")!.split(":").map((name) => {
    let index = remaining.length - 1
    while (index >= 0 && remaining[index]!.slice(0, remaining[index]!.indexOf(":")).toLowerCase() !== name) index--
    return index < 0 ? "" : canonical(remaining.splice(index, 1)[0]!) + "\r\n"
  }).join("")
  const input = selected + canonical(signature.replace(/\bb=[^;]*/, "b="))
  const lines = wire.slice(separator + 4).split("\r\n").map((line) =>
    line.replace(/[ \t]+/g, " ").replace(/ +$/, "")
  )
  while (lines.at(-1) === "") lines.pop()
  const body = lines.length === 0 ? "" : lines.join("\r\n") + "\r\n"
  return {
    signature: createVerify("RSA-SHA256").update(input, "latin1").verify(keyPair.publicKey, tags.get("b")!, "base64"),
    body: createHash("sha256").update(body, "latin1").digest("base64") === tags.get("bh")
  }
}

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
      assert.deepStrictEqual(verify(signed), { signature: true, body: true })
      const tampered = new TextEncoder().encode(text.replace("Subject: Signed", "Subject: Changed"))
      assert.isFalse(verify(tampered).signature)
      const changedBody = new TextEncoder().encode(text.replace("\r\n\r\n", "\r\n\r\nX"))
      assert.isFalse(verify(changedBody).body)
    }))

  it.effect("signs repeated headers from the bottom and preserves binary MIME", () =>
    Effect.gen(function* () {
      const unsigned = Buffer.concat([
        Buffer.from("From: sender@example.com\r\nX-Test: first\r\nX-Test: second\r\n\r\n"),
        Buffer.from([255, 128]), Buffer.from(" \t\r\n\t\r\n")
      ])
      const signed = yield* Dkim.sign(unsigned, {
        domain: "example.com", selector: "test", privateKey,
        headers: ["from", "x-test", "x-test"]
      })
      assert.deepStrictEqual(verify(signed), { signature: true, body: true })
      assert.deepStrictEqual(signed.slice(-unsigned.length), new Uint8Array(unsigned))
    }))

  it.effect("verifies empty relaxed bodies and rejects unsigned From headers", () =>
    Effect.gen(function* () {
      const unsigned = new TextEncoder().encode("From: sender@example.com\r\nSubject: Test\r\n\r\n \t\r\n")
      const signed = yield* Dkim.sign(unsigned, { domain: "example.com", selector: "test", privateKey })
      assert.deepStrictEqual(verify(signed), { signature: true, body: true })
      const rejected = yield* Effect.result(Dkim.sign(unsigned, {
        domain: "example.com", selector: "test", privateKey, headers: ["subject"]
      }))
      assert.strictEqual(rejected._tag, "Failure")
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
