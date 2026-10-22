import { Effect } from "effect"
import * as Email from "../src/Email"
import { routeName } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as TransportRegistry from "../src/TransportRegistry"

const program = Effect.gen(function* () {
  const primary = yield* Mock.makeClient()
  const secondary = yield* Mock.makeClient()

  const registry = yield* TransportRegistry.make({
    default: primary.transport,
    bulk: secondary.transport
  })

  const emailLayer = Email.layerFromRegistry({
    defaultFrom: "billing@example.com",
    registry
  })

  yield* Email.send({
    to: "customer@example.com",
    subject: "Default route",
    text: "Sent through the default transport."
  }).pipe(Effect.provide(emailLayer))

  yield* Email.send(
    {
      to: "customer@example.com",
      subject: "Bulk route",
      text: "Sent through the bulk transport."
    },
    { route: routeName("bulk") }
  ).pipe(Effect.provide(emailLayer))

  return {
    primary: (yield* primary.inbox.messages).length,
    secondary: (yield* secondary.inbox.messages).length
  }
})

const result = await Effect.runPromise(program)

console.log("default route messages", result.primary)
console.log("bulk route messages", result.secondary)
