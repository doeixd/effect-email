import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Message from "../src/Message"
import * as Routing from "../src/Routing"
import { routeName } from "../src/Ids"
import * as RecordingTransport from "../src/testing/RecordingTransport"

const prepared = Message.prepare(
  {
    to: "customer@example.com",
    subject: "Routing",
    text: "Body",
    tags: ["billing"]
  },
  { from: "billing@example.com" }
)

describe("Routing.explain", () => {
  it.effect("reports capability reasons without sending", () =>
    Effect.gen(function* () {
      const capable = yield* RecordingTransport.make({
        capabilities: { tags: true, nativeBatch: true }
      })
      const limited = yield* RecordingTransport.make({
        capabilities: { tags: false }
      })
      const message = yield* prepared
      const explanation = yield* Routing.explain(message, {
        candidates: [
          { route: routeName("primary"), transport: capable.transport },
          { route: routeName("limited"), transport: limited.transport }
        ],
        prefer: ["nativeBatch"]
      })

      assert.isTrue(explanation.requirements.tags)
      assert.strictEqual(explanation.eligible.length, 1)
      assert.strictEqual(explanation.candidates[1]?.eligible, false)
      assert.strictEqual(
        explanation.candidates[1]?.reasons[0]?.capability,
        "tags"
      )
      assert.deepStrictEqual(
        explanation.candidates[0]?.preferences,
        ["nativeBatch"]
      )
      assert.strictEqual((yield* capable.attempts).length, 0)
      assert.strictEqual((yield* limited.attempts).length, 0)
    }))

  it.effect("keeps explicit route selection inside its boundary", () =>
    Effect.gen(function* () {
      const first = yield* RecordingTransport.make({
        capabilities: { tags: true }
      })
      const second = yield* RecordingTransport.make({
        capabilities: { tags: true }
      })
      const message = yield* prepared
      const explanation = yield* Routing.explain(message, {
        candidates: [
          { route: routeName("first"), transport: first.transport },
          { route: routeName("second"), transport: second.transport }
        ],
        route: routeName("second")
      })

      assert.strictEqual(explanation.eligible.length, 1)
      assert.strictEqual(
        explanation.eligible[0]?.route,
        routeName("second")
      )
      assert.strictEqual(
        explanation.candidates[0]?.reasons[0]?.capability,
        "route"
      )
    }))
})
