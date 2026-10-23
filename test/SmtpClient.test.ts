import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import * as Email from "../src/Email"
import * as NodeSmtp from "../src/smtp/Node"
import type { SmtpSubmission } from "../src/smtp/Protocol"
import * as Smtp from "../src/providers/Smtp"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import { tenantId } from "../src/Ids"

describe("SMTP client", () => {
  it.live("preserves a null reverse path through admission and queued SMTP delivery", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const server = yield* NodeSmtp.start({
        host: "127.0.0.1",
        port: 0,
        admit: (submission) => Effect.sync(() => { submissions.push(submission) })
      })
      yield* server.run.pipe(Effect.forkScoped)
      const transport = yield* Smtp.make({
        host: "127.0.0.1",
        port: "port" in server.address ? server.address.port : 0
      })
      const content = new TextEncoder().encode("From: original@example.com\r\nTo: header@example.com\r\nSubject: Bounce\r\n\r\nUndeliverable\r\n")
      yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.make({ defaultFrom: "default@example.com" })
        yield* admission.acceptRaw(tenantId("smtp-forward"), {
          mailFrom: null,
          rcptTo: ["envelope@example.com"],
          content
        })
        yield* admission.queue.take((job, metadata) => Submissions.processSubmission(job, metadata))
      }).pipe(
        Effect.provide(Layer.mergeAll(
          DeliveryStore.layerMemory,
          Submissions.layerFactoryMemory,
          Email.layer({ defaultFrom: "default@example.com", routes: { default: transport } })
        ))
      )
      assert.strictEqual(submissions.length, 1)
      assert.isNull(submissions[0]!.mailFrom)
      assert.deepStrictEqual(submissions[0]!.rcptTo, ["envelope@example.com"])
      assert.deepStrictEqual(submissions[0]!.content, content)
    }).pipe(Effect.scoped))

  it.live("uses explicit envelope addresses independently of message headers", () =>
    Effect.gen(function* () {
      const submissions: Array<SmtpSubmission> = []
      const server = yield* NodeSmtp.start({
        host: "127.0.0.1", port: 0,
        admit: (submission) => Effect.sync(() => { submissions.push(submission) })
      })
      yield* server.run.pipe(Effect.forkScoped)
      const transport = yield* Smtp.make({
        host: "127.0.0.1", port: "port" in server.address ? server.address.port : 0
      })
      const emailLayer = Email.layer({ defaultFrom: "header-from@example.com", routes: { default: transport } })
      yield* Email.send({ to: "header-to@example.com", subject: "Envelope", text: "Body" }, {
        rawEnvelope: { mailFrom: "bounce@example.com", rcptTo: ["actual@example.com"] }
      }).pipe(Effect.provide(emailLayer))
      assert.strictEqual(submissions[0]!.mailFrom, "bounce@example.com")
      assert.deepStrictEqual(submissions[0]!.rcptTo, ["actual@example.com"])
      assert.include(new TextDecoder().decode(submissions[0]!.content), "To: header-to@example.com")
      const invalid = yield* Effect.result(Email.send({ to: "header-to@example.com", subject: "Invalid", text: "Body" }, {
        rawEnvelope: { mailFrom: "bounce@example.com\r\nQUIT", rcptTo: ["actual@example.com"] }
      }).pipe(Effect.provide(emailLayer)))
      assert.strictEqual(invalid._tag === "Failure" && invalid.failure._tag, "InvalidMessage")
      assert.strictEqual(submissions.length, 1)
    }).pipe(Effect.scoped))

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
