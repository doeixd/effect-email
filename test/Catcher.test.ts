import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as DeliveryStore from "../src/DeliveryStore"
import { deliveryId, tenantId } from "../src/Ids"
import * as Catcher from "../src/server/Catcher"

const delivery = deliveryId("dlv_catcher_1")
const tenant = tenantId("tenant_catcher")

const request = (path: string) =>
  HttpServerRequest.fromWeb(new Request(`http://localhost${path}`))

const allowAll = Catcher.make({ authorize: () => Effect.void })

const get = (
  path: string,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    DeliveryStore.DeliveryStore | HttpServerRequest.HttpServerRequest
  > = allowAll
): Effect.Effect<{ status: number; body: any }, never, DeliveryStore.DeliveryStore> =>
  Effect.gen(function* () {
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request(path)
      )
    )
    const web = HttpServerResponse.toWeb(response)
    return {
      status: web.status,
      body: yield* Effect.promise(() => web.json())
    }
  })

describe("Catcher", () => {
  it.effect("denies requests by default", () =>
    Effect.gen(function* () {
      const response = yield* get(
        "/v1/catcher/emails",
        Catcher.handler
      ).pipe(Effect.provide(DeliveryStore.layerMemory))

      assert.strictEqual(response.status, 401)
    }))

  it.effect("lists captured intents", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent({
        deliveryId: delivery,
        tenantId: tenant,
        message: {
          to: "catcher@example.com",
          subject: "Captured",
          text: "Body"
        },
        defaultFrom: "billing@example.com"
      })

      const listed = yield* get("/v1/catcher/emails")

      assert.strictEqual(listed.status, 200)
      assert.strictEqual(listed.body.emails.length, 1)
      assert.strictEqual(
        listed.body.emails[0].deliveryId,
        delivery
      )
      assert.strictEqual(listed.body.emails[0].subject, "Captured")
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))

  it.effect("returns one captured intent and 404 for a missing one", () =>
    Effect.gen(function* () {
      const store = yield* DeliveryStore.DeliveryStore
      yield* store.createIntent({
        deliveryId: delivery,
        tenantId: tenant,
        message: {
          to: "catcher@example.com",
          subject: "Captured detail",
          text: "Body"
        },
        defaultFrom: "billing@example.com"
      })

      const found = yield* get(`/v1/catcher/emails/${delivery}`)
      const missing = yield* get("/v1/catcher/emails/dlv_missing")

      assert.strictEqual(found.status, 200)
      assert.strictEqual(found.body.subject, "Captured detail")
      assert.strictEqual(found.body.message.text, "Body")
      assert.strictEqual(missing.status, 404)
    }).pipe(Effect.provide(DeliveryStore.layerMemory)))
})
