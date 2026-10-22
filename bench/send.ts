import { Effect } from "effect"
import * as Email from "../src/Email"
import * as Mock from "../src/providers/Mock"

const count = Number(process.env.MESSAGES ?? 20_000)
const inputs = Array.from({ length: count }, (_, index) => ({
  to: `user${index}@example.com`,
  subject: `Benchmark ${index}`,
  text: "Benchmark body"
}))

const run = (batch: ReadonlyArray<(typeof inputs)[number]>) =>
  Effect.gen(function* () {
    const client = yield* Mock.makeClient()
    const layer = Email.layer({
      defaultFrom: "bench@example.com",
      routes: { default: client.transport }
    })
    const outcomes = yield* Email.sendBatch(batch, {
      concurrency: 8
    }).pipe(Effect.provide(layer))
    return outcomes.filter((outcome) => outcome._tag === "accepted").length
  })

await Effect.runPromise(run(inputs.slice(0, Math.min(1_000, count))))
const started = performance.now()
const accepted = await Effect.runPromise(run(inputs))
const elapsed = performance.now() - started
const perSecond = Math.round((accepted / elapsed) * 1000)

console.log(
  `${accepted} accepted in ${elapsed.toFixed(0)}ms (${perSecond}/s)`
)
