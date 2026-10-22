import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import { WorkflowEngine } from "effect/workflow"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as DeliveryStore from "../src/DeliveryStore"
import * as Email from "../src/Email"
import { UnsupportedCapability } from "../src/EmailError"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"
import * as Gateway from "../src/server/Gateway"
import * as SubmitWorkflow from "../src/workflow/Submissions"

const tenant = tenantId("tenant_gateway")
const delivery = deliveryId("dlv_gateway_1")

const requestBody = {
  tenantId: tenant,
  deliveryId: delivery,
  message: {
    to: "gateway@example.com",
    subject: "Gateway",
    text: "Gateway body"
  }
}

const layersFor = (
  client: Mock.MockClient,
  options: Omit<
    SubmissionAdmission.SubmissionAdmissionOptions,
    "defaultFrom"
  > = {}
) =>
  SubmissionAdmission.layer({
    defaultFrom: "billing@example.com",
    ...options
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

const layersForWorkflow = (client: Mock.MockClient) => {
  const shared = Layer.mergeAll(
    DeliveryStore.layerMemory,
    Submissions.layerFactoryMemory,
    Email.layer({
      defaultFrom: "billing@example.com",
      routes: { default: client.transport }
    })
  )
  const engine = WorkflowEngine.layerMemory
  const admission = SubmissionAdmission.layer({
    defaultFrom: "billing@example.com"
  }).pipe(Layer.provideMerge(shared))
  const workflow = SubmitWorkflow.layerWaitForDeliveryEvent.pipe(
    Layer.provide(Layer.merge(shared, engine))
  )
  return Layer.mergeAll(admission, engine, workflow)
}

const allowAll = Gateway.make({
  authorize: () => Effect.void,
  verifyEvent: () => Effect.void
})

const send = (
  method: string,
  path: string,
  body?: unknown,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | SubmissionAdmission.SubmissionAdmission
  > = allowAll
): Effect.Effect<
  { status: number; body: any },
  never,
  SubmissionAdmission.SubmissionAdmission
> =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            })
      })
    )
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request
      )
    )
    const web = HttpServerResponse.toWeb(response)
    const parsed = yield* Effect.promise(() =>
      web.status === 204 ? Promise.resolve(undefined) : web.json()
    )
    return { status: web.status, body: parsed }
  })

describe("Gateway", () => {
  it.effect("accepts a submission and exposes its status", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        const accepted = yield* send(
          "POST",
          "/v1/emails",
          requestBody
        )
        const queued = yield* admission.get(delivery)
        yield* admission.queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        const status = yield* send("GET", `/v1/emails/${delivery}`)
        const redrive = yield* send(
          "POST",
          `/v1/emails/${delivery}/redrive`
        )
        yield* admission.queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        const redriven = yield* send(
          "GET",
          `/v1/emails/${delivery}`
        )
        const event = yield* send(
          "POST",
          `/v1/emails/${delivery}/events`,
          { id: "evt_1", type: "delivered" }
        )
        const events = yield* send(
          "GET",
          `/v1/emails/${delivery}/events`
        )
        const delivered = yield* send(
          "GET",
          `/v1/emails/${delivery}`
        )
        return {
          accepted,
          queued,
          status,
          redrive,
          redriven,
          event,
          events,
          delivered
        }
      }).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(result.accepted.status, 202)
      assert.strictEqual(
        result.accepted.body.deliveryId,
        delivery
      )
      assert.isTrue(Option.isSome(result.queued))
      assert.strictEqual(result.status.status, 200)
      assert.strictEqual(result.status.body.status, "accepted")
      assert.strictEqual(result.redrive.status, 202)
      assert.strictEqual(result.redriven.body.status, "accepted")
      assert.strictEqual(result.event.status, 202)
      assert.isTrue(result.event.body.inserted)
      assert.strictEqual(result.events.body.events.length, 1)
      assert.strictEqual(result.delivered.body.status, "delivered")
      assert.strictEqual(
        result.events.body.events[0].type,
        "delivered"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 2)
    }))

  it.effect("records cancellation without sending", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        yield* send("POST", "/emails", requestBody)
        const canceled = yield* send(
          "DELETE",
          `/emails/${delivery}`
        )
        yield* admission.queue.take((job, metadata) =>
          Submissions.processSubmission(job, metadata)
        )
        return {
          canceled,
          stored: yield* admission.get(delivery)
        }
      }).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(result.canceled.status, 202)
      assert.isTrue(Option.isSome(result.stored))
      assert.isTrue(
        Option.isSome(result.stored) &&
          result.stored.value.cancellationRequested
      )
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("records cancellation before a delayed intent exists", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const response = yield* send(
        "DELETE",
        "/v1/emails/dlv_delayed_cancel"
      ).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(response.status, 202)
    }))

  it.effect("lists failed deliveries", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        fail: { code: "NETWORK" }
      })
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        yield* send("POST", "/v1/emails", requestBody)
        yield* Effect.result(
          admission.queue.take((job, metadata) =>
            Submissions.processSubmission(job, metadata, {
              maxAttempts: 1
            })
          )
        )
        return yield* send(
          "GET",
          "/v1/deliveries?status=failed"
        )
      }).pipe(
        Effect.provide(layersFor(client, { maxAttempts: 1 }))
      )

      assert.strictEqual(result.status, 200)
      assert.strictEqual(result.body.deliveries.length, 1)
      assert.strictEqual(
        result.body.deliveries[0].status,
        "failed"
      )
    }))

  it.effect("reports dead-letter diagnostics", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient({
        fail: { code: "NETWORK" }
      })
      const result = yield* Effect.gen(function* () {
        const admission = yield* SubmissionAdmission.SubmissionAdmission
        yield* send("POST", "/v1/emails", requestBody)
        yield* Effect.result(
          admission.queue.take((job, metadata) =>
            Submissions.processSubmission(job, metadata, {
              maxAttempts: 1
            })
          )
        )
        return yield* send("GET", "/v1/diagnostics")
      }).pipe(
        Effect.provide(layersFor(client, { maxAttempts: 1 }))
      )

      assert.strictEqual(result.status, 200)
      assert.strictEqual(result.body.deadLetter.failed, 1)
      assert.strictEqual(result.body.parked.uncertain, 0)
      assert.strictEqual(result.body.queue.pending, 0)
      assert.isString(result.body.deadLetter.oldestFailedAt)
    }))

  it.live("resumes a waiting workflow when a provider event arrives", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const result = yield* Effect.gen(function* () {
        yield* send("POST", "/v1/emails", requestBody)
        const fiber = yield* SubmitWorkflow.WaitForDeliveryEvent.execute({
          tenantId: tenant,
          deliveryId: delivery
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        const posted = yield* send(
          "POST",
          `/v1/emails/${delivery}/events`,
          { id: "evt_gateway_wait", type: "delivered" }
        )
        return {
          posted,
          event: yield* Fiber.join(fiber)
        }
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.provide(layersForWorkflow(client)),
        Effect.scoped
      )

      assert.strictEqual(result.posted.status, 202)
      assert.strictEqual(result.event, "delivered")
    }))

  it.effect("reports readiness", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const response = yield* send("GET", "/healthz").pipe(
        Effect.provide(layersFor(client))
      )

      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.body.status, "ok")
    }))

  it.effect("denies operational routes by default", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const denied = yield* send(
        "GET",
        "/v1/diagnostics",
        undefined,
        Gateway.handler
      ).pipe(Effect.provide(layersFor(client)))
      const health = yield* send(
        "GET",
        "/healthz",
        undefined,
        Gateway.handler
      ).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(denied.status, 401)
      assert.strictEqual(health.status, 200)
    }))

  it.effect("requires provider event verification", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const handler = Gateway.make({
        authorize: () => Effect.void
      })
      const response = yield* send(
        "POST",
        `/v1/emails/${delivery}/events`,
        { id: "evt_unverified", type: "delivered" },
        handler
      ).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(response.status, 401)
    }))

  it.effect("enforces optional authorization on operational routes", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const handler = Gateway.make({
        authorize: () =>
          Effect.fail(
            new UnsupportedCapability({
              message: "not authorized",
              capability: "authorization"
            })
          )
      })
      const denied = yield* send(
        "GET",
        "/v1/diagnostics",
        undefined,
        handler
      ).pipe(Effect.provide(layersFor(client)))
      const health = yield* send(
        "GET",
        "/healthz",
        undefined,
        handler
      ).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(denied.status, 403)
      assert.strictEqual(health.status, 200)
    }))

  it.effect("returns 404 for an unknown delivery", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const response = yield* send(
        "GET",
        "/v1/emails/dlv_missing"
      ).pipe(Effect.provide(layersFor(client)))

      assert.strictEqual(response.status, 404)
    }))
})
