import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Layer } from "effect"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import * as Gateway from "../src/server/Gateway"
import * as NodeServer from "../src/server/Node"

const tenant = tenantId("tenant_node")
const delivery = deliveryId("dlv_node_1")

const allowAll = Gateway.make({
  authorize: () => Effect.void,
  verifyEvent: () => Effect.void
})

const layersFor = (client: Mock.MockClient) =>
  SubmissionAdmission.layer({
    defaultFrom: "billing@example.com"
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DeliveryStore.layerMemory,
        Submissions.layerFactoryMemory,
        Email.layer({
          defaultFrom: "billing@example.com",
          routes: { default: client.transport }
        })
      )
    )
  )

describe("Node server", () => {  it.live("rejects a request body over the configured limit", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const server = yield* NodeServer.serve(
          Gateway.make({
            authorize: () => Effect.void,
            maxBodySize: ByteSize.kibibytes(1)
          }),
          { host: "127.0.0.1", port: 0 }
        )
        return yield* Effect.promise(async () => {
          const response = await fetch(`${server.url}/v1/emails`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tenantId: tenant,
              message: {
                to: "node@example.com",
                subject: "Too large",
                text: "x".repeat(4_096)
              }
            })
          })
          return { status: response.status }
        })
      }).pipe(Effect.scoped, Effect.provide(layersFor(client)))

      assert.strictEqual(result.status, 413)
    }))

  it.live("serves the gateway over Node HTTP", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const admission =
          yield* SubmissionAdmission.SubmissionAdmission
        const server = yield* NodeServer.serve(allowAll, {
          host: "127.0.0.1",
          port: 0
        })
        const accepted = yield* Effect.promise(async () => {
          const response = await fetch(`${server.url}/v1/emails`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tenantId: tenant,
              deliveryId: delivery,
              message: {
                to: "node@example.com",
                subject: "Node",
                text: "Node body"
              }
            })
          })
          return {
            status: response.status,
            body: await response.json()
          }
        })
        yield* admission.queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        const status = yield* Effect.promise(async () => {
          const response = await fetch(
            `${server.url}/v1/emails/${delivery}`
          )
          return {
            status: response.status,
            body: await response.json()
          }
        })
        return { accepted, status, port: server.port }
      }).pipe(
        Effect.scoped,
        Effect.provide(layersFor(client))
      )

      assert.isAbove(result.port, 0)
      assert.strictEqual(result.accepted.status, 202)
      assert.strictEqual(result.accepted.body.deliveryId, delivery)
      assert.strictEqual(result.status.status, 200)
      assert.strictEqual(result.status.body.status, "accepted")
      assert.strictEqual((yield* client.inbox.messages).length, 1)
    }))
})
