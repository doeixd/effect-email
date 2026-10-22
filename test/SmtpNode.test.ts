import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { createConnection } from "node:net"
import * as DeliveryStore from "../src/DeliveryStore"
import { tenantId } from "../src/Ids"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import type { SmtpSubmission } from "../src/smtp/Protocol"
import * as NodeSmtp from "../src/smtp/Node"

const transcript =
  "EHLO client\r\n" +
  "MAIL FROM:<sender@example.com>\r\n" +
  "RCPT TO:<user@example.com>\r\n" +
  "DATA\r\n" +
  "Subject: node\r\n\r\nBody\r\n" +
  ".\r\n" +
  "QUIT\r\n"

const exchange = (
  port: number,
  payload: string
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(
      { host: "127.0.0.1", port },
      () => {
        socket.write(payload)
      }
    )
    let received = ""
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out waiting for SMTP response: ${received}`))
    }, 5_000)
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      received += chunk
      if (received.includes("221 ")) {
        clearTimeout(timeout)
        socket.end()
        resolve(received)
      }
    })
    socket.on("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
  })

describe("Node SMTP server", () => {
  it.live("accepts a pipelined message over TCP", () =>
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
      const received = yield* Effect.promise(() =>
        exchange(port, transcript)
      )

      assert.include(received, "220 ")
      assert.include(received, "354 ")
      assert.include(received, "250 ")
      assert.include(received, "221 ")
      assert.strictEqual(submissions.length, 1)
      assert.strictEqual(
        new TextDecoder().decode(submissions[0]!.content),
        "Subject: node\r\n\r\nBody\r\n"
      )
      assert.deepStrictEqual(submissions[0]!.rcptTo, [
        "user@example.com"
      ])
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped))

  it.live("admits raw SMTP mail into the delivery store", () =>
    Effect.gen(function* () {
      const tenant = tenantId("tenant_smtp")
      const layers = SubmissionAdmission.layer({
        defaultFrom: "fallback@example.com"
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            DeliveryStore.layerMemory,
            Submissions.layerFactoryMemory
          )
        )
      )

      const intents = yield* Effect.gen(function* () {
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        const store = yield* DeliveryStore.DeliveryStore
        const server = yield* NodeSmtp.start({
          host: "127.0.0.1",
          port: 0,
          admit: (submission) =>
            admission.acceptRaw(tenant, submission)
        })
        const fiber = yield* server.run.pipe(Effect.forkScoped)
        const port =
          "port" in server.address ? server.address.port : 0
        yield* Effect.promise(() => exchange(port, transcript))
        const stored = yield* store.listAll
        yield* Fiber.interrupt(fiber)
        return stored
      }).pipe(Effect.scoped, Effect.provide(layers))

      assert.strictEqual(intents.length, 1)
      assert.deepStrictEqual(intents[0]!.rawEnvelope, {
        mailFrom: "sender@example.com",
        rcptTo: ["user@example.com"]
      })
      const message = intents[0]!.message
      assert.isTrue("rawMime" in message)
      assert.strictEqual(
        "rawMime" in message
          ? new TextDecoder().decode(message.rawMime)
          : undefined,
        "Subject: node\r\n\r\nBody\r\n"
      )
    }))
})
