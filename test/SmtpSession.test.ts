import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Base64 } from "effect/encoding"
import { StoreUnavailable } from "../src/EmailError"
import * as Session from "../src/smtp/Session"
import type { SmtpSubmission } from "../src/smtp/Protocol"

const bytes = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

const connection = (chunks: ReadonlyArray<string>) => {
  const writes: Array<string> = []
  let index = 0
  return {
    writes,
    value: {
      read: Effect.suspend(() => {
        if (index >= chunks.length) {
          return Effect.fail(
            new Session.SmtpConnectionError({
              message: "connection closed by test"
            })
          )
        }
        const chunk = chunks[index]!
        index += 1
        return Effect.succeed(bytes(chunk))
      }),
      write: (chunk: Uint8Array) =>
        Effect.sync(() => {
          writes.push(new TextDecoder().decode(chunk))
        })
    } satisfies Session.SmtpConnection
  }
}

describe("SMTP session", () => {
  it.effect("accepts a pipelined transaction and preserves data bytes", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const test = connection([
        "EHLO client\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<user@example.com>\r\nDATA\r\n",
        "Subject: hello\r\n\r\nBo",
        "dy\r\n.\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })

      assert.strictEqual(submissions.length, 1)
      assert.strictEqual(
        new TextDecoder().decode(submissions[0]!.content),
        "Subject: hello\r\n\r\nBody\r\n"
      )
      assert.deepStrictEqual(submissions[0]!.rcptTo, [
        "user@example.com"
      ])
      assert.strictEqual(test.writes[0]?.slice(0, 3), "220")
      assert.isTrue(test.writes.some((reply) => reply.startsWith("354")))
      assert.isTrue(test.writes.some((reply) => reply.startsWith("250")))
      assert.strictEqual(test.writes.at(-1), "221 Bye\r\n")
    }))

  it.effect("returns 451 and continues when admission is transiently unavailable", () =>
    Effect.gen(function* () {
      const test = connection([
        "HELO client\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<user@example.com>\r\nDATA\r\n",
        "body\r\n.\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        admit: () =>
          Effect.fail(
            StoreUnavailable.new({ message: "storage down" })
          )
      })

      assert.isTrue(
        test.writes.some((reply) => reply.startsWith("451"))
      )
      assert.strictEqual(test.writes.at(-1), "221 Bye\r\n")
    }))

  it.effect("returns 552 for an oversized message", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const test = connection([
        "HELO client\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<user@example.com>\r\nDATA\r\n",
        "0123456789\r\n.\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        maxMessageBytes: 5,
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })

      assert.strictEqual(submissions.length, 0)
      assert.isTrue(
        test.writes.some((reply) => reply.startsWith("552"))
      )
      assert.strictEqual(test.writes.at(-1), "221 Bye\r\n")
    }))

  it.effect("requires and accepts AUTH PLAIN when configured", () =>
    Effect.gen(function* () {
      const credentials: Array<Session.SmtpCredentials> = []
      const submissions: Array<SmtpSubmission> = []
      const token = Base64.encode(
        new TextEncoder().encode("\u0000user\u0000secret")
      )
      const test = connection([
        `EHLO client\r\nMAIL FROM:<sender@example.com>\r\nAUTH PLAIN ${token}\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<user@example.com>\r\nDATA\r\nbody\r\n.\r\nQUIT\r\n`
      ])

      yield* Session.runSession({
        connection: test.value,
        allowInsecureAuth: true,
        requireAuthentication: true,
        authenticate: (value) =>
          Effect.sync(() => {
            credentials.push(value)
          }),
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })

      assert.deepStrictEqual(credentials, [
        { username: "user", password: "secret" }
      ])
      assert.isTrue(test.writes.some((reply) => reply.includes("AUTH PLAIN")))
      assert.isTrue(test.writes.some((reply) => reply.startsWith("530")))
      assert.isTrue(test.writes.some((reply) => reply.startsWith("235")))
      assert.strictEqual(submissions.length, 1)
      assert.strictEqual(test.writes.at(-1), "221 Bye\r\n")
    }))

  it.effect("passes the authenticated principal into admission", () =>
    Effect.gen(function* () {
      const contexts: Array<
        Session.SmtpAdmissionContext<{ readonly tenantId: string }>
      > = []
      const token = Base64.encode(
        new TextEncoder().encode("\u0000user\u0000secret")
      )
      const test = connection([
        `EHLO client\r\nAUTH PLAIN ${token}\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<user@example.com>\r\nDATA\r\nbody\r\n.\r\nQUIT\r\n`
      ])

      yield* Session.runSession({
        connection: test.value,
        allowInsecureAuth: true,
        authenticate: () =>
          Effect.succeed({ tenantId: "tenant-1" }),
        admit: (_submission, context) =>
          Effect.sync(() => {
            contexts.push(context)
          })
      })

      assert.deepStrictEqual(contexts, [
        {
          authenticated: true,
          principal: { tenantId: "tenant-1" },
          tls: false
        }
      ])
    }))

  it.effect("requires authentication by default when credentials are configured", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const test = connection([
        "EHLO client\r\nMAIL FROM:<sender@example.com>\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        allowInsecureAuth: true,
        authenticate: () => Effect.void,
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })

      assert.strictEqual(submissions.length, 0)
      assert.isTrue(
        test.writes.some((reply) => reply.startsWith("530"))
      )
    }))

  it.effect("limits the number of recipients per transaction", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const test = connection([
        "EHLO client\r\nMAIL FROM:<sender@example.com>\r\nRCPT TO:<one@example.com>\r\nRCPT TO:<two@example.com>\r\nDATA\r\nbody\r\n.\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        maxRecipients: 1,
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })

      assert.strictEqual(submissions.length, 1)
      assert.deepStrictEqual(submissions[0]!.rcptTo, [
        "one@example.com"
      ])
      assert.isTrue(
        test.writes.some((reply) => reply.startsWith("452"))
      )
    }))
  it.effect("upgrades with STARTTLS and resets the session state", () =>
    Effect.gen(function* () {
      let upgraded = false
      const test = connection([
        "EHLO client\r\nSTARTTLS\r\n",
        "EHLO client\r\nQUIT\r\n"
      ])

      yield* Session.runSession({
        connection: test.value,
        upgradeTls: Effect.sync(() => {
          upgraded = true
        }),
        admit: () => Effect.void
      })

      assert.isTrue(upgraded)
      assert.isTrue(
        test.writes.some((reply) => reply.startsWith("220 Ready"))
      )
      assert.strictEqual(
        test.writes.filter((reply) => reply.includes("STARTTLS")).length,
        1
      )
      assert.strictEqual(test.writes.at(-1), "221 Bye\r\n")
    }))
})
