import { Context, Effect, Layer } from "effect"
import * as Email from "../src/Email"
import * as EmailTransport from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"

const program = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(Mock.layerWithClient())
    const client = Context.get(context, Mock.Client)
    const transport = Context.get(
      context,
      EmailTransport.EmailTransport
    )
    const emailLayer = Email.layer({
      defaultFrom: "billing@example.com",
      routes: { default: transport }
    })

    yield* Email.send({
      to: "customer@example.com",
      subject: "Provider layer",
      text: "The transport came from a provider layer."
    }).pipe(Effect.provide(emailLayer))

    return {
      sameTransport: client.transport === transport,
      messages: (yield* client.inbox.messages).length
    }
  })
)

const result = await Effect.runPromise(program)

console.log("same transport instance", result.sameTransport)
console.log("mock inbox", result.messages)
