import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { createServer, type Socket } from "node:net"
import * as Email from "../src/Email"
import * as Smtp from "../src/providers/Smtp"
import { withRetry } from "../src/EmailTransport"

const peer = (stallFirstDataReply = false) => Effect.acquireRelease(
  Effect.promise(async () => {
    const sockets = new Set<Socket>()
    const commands: Array<string> = []
    let connections = 0
    let accepted = 0
    let forced = false
    const server = createServer((socket) => {
      const connection = ++connections
      sockets.add(socket)
      socket.on("error", () => {})
      socket.on("close", () => sockets.delete(socket))
      socket.write("220 local\r\n")
      let buffer = ""
      let data = false
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        while (buffer.length > 0) {
          if (data) {
            const end = buffer.indexOf("\r\n.\r\n")
            if (end < 0) return
            buffer = buffer.slice(end + 5)
            data = false
            accepted++
            if (!(stallFirstDataReply && connection === 1)) socket.write("250 accepted\r\n")
            continue
          }
          const end = buffer.indexOf("\r\n")
          if (end < 0) return
          const command = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          commands.push(command.split(" ")[0]!)
          if (command.startsWith("EHLO")) socket.write("250 local\r\n")
          else if (command.startsWith("MAIL") || command.startsWith("RCPT")) socket.write("250 ok\r\n")
          else if (command === "DATA") { data = true; socket.write("354 send\r\n") }
          // RSET and QUIT deliberately receive no reply.
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("expected TCP address")
    // A broken uninterruptible finalizer must fail the test, not hang the suite.
    const failsafe = setTimeout(() => {
      forced = true
      for (const socket of sockets) socket.destroy()
      server.close()
    }, 1500)
    return { server, sockets, commands, failsafe, port: address.port,
      stats: () => ({ connections, accepted, forced }) }
  }),
  (resource) => Effect.promise(async () => {
    clearTimeout(resource.failsafe)
    for (const socket of resource.sockets) socket.destroy()
    await new Promise<void>((resolve) => resource.server.close(() => resolve()))
  })
)
const message = { to: "recipient@example.com", subject: "Deadline", text: "Body" }
const layer = (transport: import("../src/EmailTransport").Transport) => Email.layer({
  defaultFrom: "sender@example.com", routes: { default: transport }
})

describe("SMTP deadlines", () => {
  it.live("returns confirmed acceptance without waiting for reset or quit replies", () =>
    Effect.gen(function* () {
      const server = yield* peer()
      const transport = yield* Smtp.make({ host: "127.0.0.1", port: server.port })
      const receipt = yield* Email.send(message).pipe(Effect.provide(layer(transport)), Effect.timeout("500 millis"))
      assert.strictEqual(receipt.provider, "smtp")
      assert.strictEqual(server.stats().accepted, 1)
      assert.isFalse(server.stats().forced)
      assert.notInclude(server.commands, "RSET")
    }).pipe(Effect.scoped))

  it.live("classifies a missing DATA reply as uncertain and never retries it", () =>
    Effect.gen(function* () {
      const server = yield* peer(true)
      const transport = yield* Smtp.make({ host: "127.0.0.1", port: server.port, commandTimeoutMillis: 100 })
      const result = yield* Effect.result(Email.send(message).pipe(
        Effect.provide(layer(withRetry({ maxAttempts: 3, baseDelayMillis: 0 })(transport))),
        Effect.timeout("1 second")
      ))
      assert.strictEqual(result._tag === "Failure" && result.failure._tag, "DeliveryUncertain")
      assert.deepStrictEqual(server.stats(), { connections: 1, accepted: 1, forced: false })
    }).pipe(Effect.scoped))

  it.live("invalidates an interrupted pooled session and opens a fresh connection", () =>
    Effect.gen(function* () {
      const server = yield* peer(true)
      const transport = yield* Smtp.makePooled({ host: "127.0.0.1", port: server.port, poolSize: 1 })
      const first = yield* Effect.result(Email.send(message).pipe(Effect.provide(layer(transport)), Effect.timeout("100 millis")))
      assert.strictEqual(first._tag === "Failure" && first.failure._tag, "TimeoutError")
      const second = yield* Email.send({ ...message, to: "other@example.com" }).pipe(
        Effect.provide(layer(transport)), Effect.timeout("500 millis")
      )
      assert.strictEqual(second.provider, "smtp")
      assert.deepStrictEqual(server.stats(), { connections: 2, accepted: 2, forced: false })
    }).pipe(Effect.scoped))
})
