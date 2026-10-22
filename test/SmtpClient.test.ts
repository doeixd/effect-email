import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as Email from "../src/Email"
import * as NodeSmtp from "../src/smtp/Node"
import type { SmtpSubmission } from "../src/smtp/Protocol"
import * as Smtp from "../src/providers/Smtp"

describe("SMTP client", () => {
  it.live("delivers a structured message to a local SMTP server", () =>
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
      const transport = yield* Smtp.make({
        host: "127.0.0.1",
        port
      })
      const receipt = yield* Email.send({
        from: "sender@example.com",
        to: "user@example.com",
        subject: "SMTP client",
        text: "Hello over SMTP"
      }).pipe(
        Effect.provide(
          Email.layer({
            defaultFrom: "sender@example.com",
            routes: { default: transport }
          })
        )
      )

      yield* Fiber.interrupt(fiber)

      assert.strictEqual(receipt.provider, "smtp")
      assert.strictEqual(submissions.length, 1)
      assert.deepStrictEqual(submissions[0]!.rcptTo, [
        "user@example.com"
      ])
      const mime = new TextDecoder().decode(submissions[0]!.content)
      assert.include(mime, "Subject: SMTP client")
      assert.include(mime, "Content-Type: text/plain; charset=UTF-8")
      assert.include(mime, "SGVsbG8gb3ZlciBTTVRQ")
    }).pipe(Effect.scoped))
})
