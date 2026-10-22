import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Email from "../src/Email"
import * as Resend from "../src/providers/Resend"

const apiKey = process.env.RESEND_API_KEY

if (apiKey === undefined) {
  throw new Error("Set RESEND_API_KEY to run this example")
}

const program = Effect.gen(function* () {
  const transport = yield* Resend.make({
    apiKey: Redacted.make(apiKey)
  }).pipe(Effect.provide(FetchHttpClient.layer))

  const emailLayer = Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: transport }
  })

  return yield* Email.send({
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your order."
  }).pipe(Effect.provide(emailLayer))
})

const receipt = await Effect.runPromise(program)

console.log("accepted", receipt.providerMessageId)
