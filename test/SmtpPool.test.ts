import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as Email from "../src/Email"
import * as NodeSmtp from "../src/smtp/Node"
import type { SmtpSubmission } from "../src/smtp/Protocol"
import * as Smtp from "../src/providers/Smtp"

describe("Pooled SMTP client", () => {
  it.live("reuses a pooled connection for multiple messages", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const server = yield* NodeSmtp.start({
        host: "127.0.0.1",
        port: 0,
        admit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission)
          })
      })
      const fiber = yield* server.run.pipe(Effect.forkScoped)
      const port = "port" in server.address ? server.address.port : 0
      const transport = yield* Smtp.makePooled({
        host: "127.0.0.1",
        port,
        poolSize: 1
      })
      const layer = Email.layer({
        defaultFrom: "sender@example.com",
        routes: { default: transport }
      })

      const first = yield* Email.send({
        to: "one@example.com",
        subject: "One",
        text: "Body one"
      }).pipe(Effect.provide(layer))
      const second = yield* Email.send({
        to: "two@example.com",
        subject: "Two",
        text: "Body two"
      }).pipe(Effect.provide(layer))

      assert.strictEqual(first.provider, "smtp")
      assert.strictEqual(second.provider, "smtp")
      assert.strictEqual(submissions.length, 2)
      assert.deepStrictEqual(submissions[0]!.rcptTo, [
        "one@example.com"
      ])
      assert.deepStrictEqual(submissions[1]!.rcptTo, [
        "two@example.com"
      ])
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped))
})
