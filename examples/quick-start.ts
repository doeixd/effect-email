import { Effect } from "effect"
import * as Email from "../src/Email"
import * as Mock from "../src/providers/Mock"

const program = Effect.gen(function* () {
  const client = yield* Mock.makeClient()
  const emailLayer = Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: client.transport }
  })

  const receipt = yield* Email.send({
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your order."
  }).pipe(Effect.provide(emailLayer))

  const messages = yield* client.inbox.messages

  return { receipt, messages }
})

const { receipt, messages } = await Effect.runPromise(program)

console.log("accepted", receipt.providerMessageId)
console.log("mock inbox", messages.length)
