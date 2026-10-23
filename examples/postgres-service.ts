import { Config, Effect, Layer, Option } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as DeliveryStoreSql from "../src/DeliveryStoreSql"
import * as Email from "../src/Email"
import { deliveryId, tenantId } from "../src/Ids"
import * as Mock from "../src/providers/Mock"
import * as Submissions from "../src/queue/Submissions"
import * as Service from "../src/Service"
import * as SubmissionAdmission from "../src/SubmissionAdmission"

const tenant = tenantId("tenant_service")
const delivery = deliveryId("dlv_service_demo")

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.Redacted("DATABASE_URL")
  const client = yield* Mock.makeClient()
  const base = Layer.mergeAll(
    DeliveryStoreSql.layerSql(),
    Submissions.layerFactorySql()
  ).pipe(
    Layer.provideMerge(
      PgClient.layer({ url: databaseUrl })
    )
  )
  const emailLayer = yield* Email.layerValidated({
    defaultFrom: "billing@example.com",
    routes: { default: client.transport }
  })
  const app = Layer.mergeAll(
    SubmissionAdmission.layer({
      defaultFrom: "billing@example.com"
    }).pipe(Layer.provideMerge(base)),
    emailLayer
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

    const service = yield* Service.start({
      queue: admission.queue,
      tenantId: tenant,
      workerConcurrency: 2,
      publisherIntervalMillis: 100,
      reconcilerIntervalMillis: 1_000,
      pageSize: 100
    })

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

    const health = yield* service.health
    yield* service.shutdown

    return {
      receipt,
      status,
      health,
      messages: (yield* client.inbox.messages).length
    }
  }).pipe(Effect.provide(app), Effect.scoped)
})

const result = await Effect.runPromise(program)

console.log("admitted", result.receipt.deliveryId)
console.log("status", result.status)
console.log("mock inbox", result.messages)
