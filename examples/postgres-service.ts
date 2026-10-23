import { Effect, Fiber, Layer, Option, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import * as Email from "../src/Email"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as SubmissionAdmission from "../src/SubmissionAdmission"

const url = process.env.DATABASE_URL
if (url === undefined) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const tenant = tenantId("tenant_service")
const delivery = deliveryId("dlv_service_demo")

const program = Effect.gen(function* () {
  const client = yield* Mock.makeClient()
  const base = Layer.mergeAll(
    DeliveryStoreSql.layerSql(),
    Submissions.layerFactorySql()
  ).pipe(
    Layer.provideMerge(
      PgClient.layer({ url: Redacted.make(url) })
    )
  )
  const app = Layer.mergeAll(
    SubmissionAdmission.layer({
      defaultFrom: "billing@example.com"
    }).pipe(Layer.provideMerge(base)),
    Email.layer({
      defaultFrom: "billing@example.com",
      routes: { default: client.transport }
    })
  )

  return yield* Effect.gen(function* () {
    const admission =
      yield* SubmissionAdmission.SubmissionAdmission
    const receipt = yield* admission.accept({
      tenantId: tenant,
      deliveryId: delivery,
      message: {
        to: "customer@example.com",
        subject: "Durable service",
        text: "Accepted before dispatch."
      }
    })

    const worker = yield* Submissions.runWorker({
      concurrency: 2
    }).pipe(Effect.forkScoped)
    const publisher = yield* Submissions.runPublisher({
      queue: admission.queue,
      tenantId: tenant,
      intervalMillis: 100
    }).pipe(Effect.forkScoped)
    const reconciler = yield* Submissions.runReconciler({
      intervalMillis: 1_000
    }).pipe(Effect.forkScoped)

    const status = yield* Effect.gen(function* () {
      while (true) {
        const stored = yield* admission.get(delivery)
        if (
          Option.isSome(stored) &&
          stored.value.status !== "pending" &&
          stored.value.status !== "in-progress"
        ) {
          return stored.value.status
        }
        yield* Effect.sleep("50 millis")
      }
    }).pipe(Effect.timeout("10 seconds"))

    yield* Fiber.interrupt(worker)
    yield* Fiber.interrupt(publisher)
    yield* Fiber.interrupt(reconciler)

    return {
      receipt,
      status,
      messages: (yield* client.inbox.messages).length
    }
  }).pipe(Effect.provide(app), Effect.scoped)
})

const result = await Effect.runPromise(program)

console.log("admitted", result.receipt.deliveryId)
console.log("status", result.status)
console.log("mock inbox", result.messages)
