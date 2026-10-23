import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { WorkflowEngine } from "effect/workflow"
import * as Request from "effect/http/HttpServerRequest"
import * as Store from "../src/DeliveryStore"
import * as SqlStore from "../src/DeliveryStoreSql"
import * as Admission from "../src/SubmissionAdmission"
import * as Queue from "../src/queue/Submissions"
import * as Suppression from "../src/Suppression"
import * as Email from "../src/Email"
import * as Policy from "../src/EmailTransport"
import * as Mock from "../src/providers/Mock"
import * as Gateway from "../src/server/Gateway"
import * as Flow from "../src/workflow/Submissions"
import { prepare } from "../src/Message"
import { buildMime } from "../src/smtp/Mime"
import { StoreUnavailable, TransportUnavailable } from "../src/EmailError"
import { deliveryId, destinationId, routeName, tenantId } from "../src/Ids"
import type { SubmissionReceipt } from "../src/Submission"

const id = deliveryId("release-safety")
const tenant = tenantId("release-safety")
const message = { to: "recipient@example.com", subject: "Safety", text: "Body" }
const input = { deliveryId: id, tenantId: tenant, message, defaultFrom: "sender@example.com" }
const job: Queue.SubmissionJob = { version: 1, deliveryId: id, tenantId: tenant, dispatchGeneration: 1 }
const emailLayer = (transport: Policy.Transport) => Email.layer({
  defaultFrom: input.defaultFrom, routes: { default: transport }
})
const stores = [
  ["memory", Store.layerMemory],
  ["SQL", SqlStore.layerSql().pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })))]
] as const

describe("Release safety regressions", () => {
  for (const [name, storeLayer] of stores) {
    it.effect(`${name}: duplicate suppressed jobs cannot overwrite an active claim`, () =>
      Effect.gen(function* () {
        const store = yield* Store.DeliveryStore
        const suppression = yield* Suppression.SuppressionStore
        const client = yield* Mock.makeClient()
        yield* store.createIntent(input)
        const active = yield* store.beginAttempt(id, 1)
        yield* suppression.suppress({ tenantId: tenant, recipient: message.to })
        const result = yield* Effect.result(Queue.processSubmission(job, { id: "duplicate", attempts: 1 }).pipe(
          Effect.provide(emailLayer(client.transport))
        ))
        assert.strictEqual(result._tag, "Failure")
        const current = Option.getOrThrow(yield* store.get(id))
        assert.strictEqual(current.status, "in-progress")
        assert.strictEqual(current.claimId, active.claimId)
        const prepared = yield* prepare(message, { from: input.defaultFrom, deliveryId: id })
        const receipt = yield* client.transport.send({
          deliveryId: id, message: prepared, route: routeName("default"),
          destination: client.transport.destination,
          destinationId: destinationId(client.transport.destination)
        })
        yield* store.recordAccepted(id, 1, receipt, active.claimId)
        assert.strictEqual(Option.getOrThrow(yield* store.get(id)).status, "accepted")
      }).pipe(Effect.provide(Layer.merge(storeLayer, Suppression.layerMemory))))

    it.effect(`${name}: envelope changes conflict, including legacy fingerprints`, () =>
      Effect.gen(function* () {
        const store = yield* Store.DeliveryStore
        const original = { ...input, rawEnvelope: { mailFrom: null, rcptTo: ["original@example.com"] } }
        yield* store.createIntent(original)
        const snapshot = yield* store.snapshot
        yield* store.restore({ ...snapshot, intents: snapshot.intents.map((intent) => ({ ...intent, fingerprint: "legacy-fingerprint" })) })
        assert.strictEqual((yield* store.createIntent(original)).deliveryId, id)
        for (const rawEnvelope of [
          { mailFrom: null, rcptTo: ["different@example.com"] },
          { mailFrom: "different-sender@example.com", rcptTo: ["original@example.com"] }
        ]) {
          const result = yield* Effect.result(store.createIntent({ ...input, rawEnvelope }))
          assert.strictEqual(result._tag === "Failure" && result.failure._tag, "IdempotencyConflict")
        }
      }).pipe(Effect.provide(storeLayer)))

    it.effect(`${name}: redrive sends again with an idempotent provider and preserves its new key on replay`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        const cache = new Map<string, SubmissionReceipt>()
        const transport: Policy.Transport = {
          ...client.transport,
          capabilities: { ...client.transport.capabilities, idempotency: "message" },
          send: (envelope) => Effect.gen(function* () {
            const key = envelope.providerIdempotencyKey!
            const cached = cache.get(key)
            if (cached !== undefined) return cached
            const receipt = yield* client.transport.send(envelope)
            cache.set(key, receipt)
            return receipt
          })
        }
        yield* Effect.gen(function* () {
          const store = yield* Store.DeliveryStore
          const first = yield* store.createIntent({ ...input, providerIdempotencyKey: "caller-key" })
          yield* Queue.processSubmission(job, { id: "first", attempts: 1 })
          const second = yield* store.redrive(id)
          assert.notStrictEqual(second.providerIdempotencyKey, first.providerIdempotencyKey)
          const redriven = { ...job, dispatchGeneration: second.dispatchGeneration }
          yield* Queue.processSubmission(redriven, { id: "second", attempts: 1 })
          yield* Queue.processSubmission(redriven, { id: "replayed", attempts: 1 })
          assert.strictEqual(Option.getOrThrow(yield* store.get(id)).providerIdempotencyKey, second.providerIdempotencyKey)
          const third = yield* store.redrive(id)
          assert.notStrictEqual(third.providerIdempotencyKey, second.providerIdempotencyKey)
          assert.strictEqual((yield* client.inbox.messages).length, 2)
        }).pipe(Effect.provide(Layer.merge(storeLayer, emailLayer(transport))))
      }))
  }

  it.effect("SQL preserves marker-shaped JSON, bytes, dates, and canonical event lookup", () =>
    Effect.gen(function* () {
      const store = yield* Store.DeliveryStore
      const json = { __effect_email_bytes__: "aGVsbG8=", __effect_email_datetime__: "invalid-date", ordinary: "keep" }
      const bytes = new TextEncoder().encode("attachment")
      const prepared = yield* prepare({
        to: message.to, subject: message.subject,
        providerTemplate: { id: "remote", variables: { customer: json } },
        attachments: [{ filename: "a.txt", source: { _tag: "content", content: bytes } }]
      }, { from: input.defaultFrom, deliveryId: id })
      yield* store.createIntent({ ...input, message: prepared })
      const stored = Option.getOrThrow(yield* store.get(id))
      assert.isTrue(DateTime.isDateTime(stored.createdAt))
      assert.deepStrictEqual(stored.message, prepared)
      const propsId = deliveryId("json-props")
      yield* store.createIntent({ ...input, deliveryId: propsId, message: { to: message.to, subject: "Props", template: { id: "local", props: json } } })
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(propsId)).message, { to: message.to, subject: "Props", template: { id: "local", props: json } })
      const now = yield* DateTime.now
      const payload = { __effect_email_datetime__: "invalid-date", nested: json }
      yield* store.appendProviderEvent({ id: "json-event", deliveryId: id, type: "unknown", occurredAt: now, payload })
      const event = Option.getOrThrow(yield* store.getEvent("json-event"))
      assert.deepStrictEqual(event.payload, payload)
      assert.isTrue(DateTime.isDateTime(event.occurredAt))
      assert.deepStrictEqual((yield* store.listEvents(id))[0]!.payload, payload)
      assert.isTrue(Option.isNone(yield* store.getEvent("missing")))
      const client = yield* Mock.makeClient()
      yield* store.recordAccepted(id, 1, {
        provider: "mock", destinationId: destinationId(client.transport.destination), acceptedAt: now, metadata: { nested: json }
      })
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(id)).receipt?.metadata, { nested: json })
    }).pipe(Effect.provide(stores[1][1])))

  for (const retry of [false, true]) {
    it.effect(`conflicting batch indexes are uncertain and never resent (retry: ${retry})`, () =>
      Effect.gen(function* () {
        const client = yield* Mock.makeClient()
        let calls = 0
        const base: Policy.NativeBatchTransport = {
          ...client.transport,
          capabilities: { ...client.transport.capabilities, partialBatchRetry: true },
          sendBatch: (envelopes) => Effect.gen(function* () {
            calls++
            const receipt = yield* client.transport.send(envelopes[0]!)
            return [
              { _tag: "accepted", index: 0, receipt },
              { _tag: "rejected", index: 0, error: TransportUnavailable.new({ message: "conflicting row", retryable: true }) }
            ]
          })
        }
        const transport = retry ? Policy.withRetry({ maxAttempts: 2, baseDelayMillis: 0 })(base) : base
        const outcomes = yield* Email.sendBatch([message]).pipe(Effect.provide(emailLayer(transport)))
        assert.strictEqual(outcomes[0]!._tag, "uncertain")
        assert.strictEqual(calls, 1)
        assert.strictEqual((yield* client.inbox.messages).length, 1)
      }))
  }

  it.effect("suppression retries use the original event even if the duplicate body changes", () =>
    Effect.gen(function* () {
      const suppression = yield* Suppression.SuppressionStore
      let attempts = 0
      yield* Effect.gen(function* () {
        const store = yield* Store.DeliveryStore
        const admission = yield* Admission.make({ defaultFrom: input.defaultFrom })
        yield* store.createIntent(input)
        const event = { id: "complaint", deliveryId: id, type: "complained" as const, occurredAt: yield* DateTime.now }
        const failed = yield* Effect.result(admission.appendProviderEvent(event))
        assert.strictEqual(failed._tag === "Failure" && failed.failure._tag, "StoreUnavailable")
        assert.strictEqual(yield* admission.appendProviderEvent({ ...event, type: "opened", recipient: "other@example.com" }), false)
        assert.strictEqual(attempts, 2)
        assert.isTrue(Option.isSome(yield* suppression.isSuppressed(tenant, message.to)))
        assert.isTrue(Option.isNone(yield* suppression.isSuppressed(tenant, "other@example.com")))
      }).pipe(Effect.provideService(Suppression.SuppressionStore, {
        ...suppression,
        suppress: (record) => Effect.suspend(() => ++attempts === 1
          ? Effect.fail(StoreUnavailable.new({ message: "temporary outage" }))
          : suppression.suppress(record))
      }))
    }).pipe(Effect.provide(Layer.mergeAll(Store.layerMemory, Queue.layerFactoryMemory, Suppression.layerMemory))))

  it.live("gateway returns 503 when notifying fails, then replay wakes the existing waiter", () => {
    const shared = Layer.mergeAll(Store.layerMemory, Queue.layerFactoryMemory, WorkflowEngine.layerMemory)
    const app = Layer.merge(shared, Flow.layerWaitForDeliveryEvent.pipe(Layer.provide(shared)))
    return Effect.gen(function* () {
      const store = yield* Store.DeliveryStore
      const engine = yield* WorkflowEngine.WorkflowEngine
      const admission = yield* Admission.make({ defaultFrom: input.defaultFrom })
      yield* store.createIntent(input)
      const waiting = yield* Flow.WaitForDeliveryEvent.execute({ tenantId: tenant, deliveryId: id, types: ["delivered"] }).pipe(Effect.forkScoped)
      while ((yield* store.listEventWaits(id)).length === 0) yield* Effect.sleep(1)
      let attempts = 0
      const post = (type: string) => Gateway.make({ authorize: () => Effect.void, verifyEvent: () => Effect.void }).pipe(
        Effect.provideService(Admission.SubmissionAdmission, admission),
        Effect.provideService(Request.HttpServerRequest, Request.fromWeb(new globalThis.Request(`http://localhost/emails/${id}/events`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "delivered", type })
        }))),
        Effect.provideService(WorkflowEngine.WorkflowEngine, {
          ...engine,
          deferredDone: (deferred, options) => Effect.suspend(() => ++attempts === 1
            ? Effect.die(new Error("workflow backend outage"))
            : engine.deferredDone(deferred, options))
        })
      )
      assert.strictEqual((yield* post("delivered")).status, 503)
      assert.isUndefined(waiting.pollUnsafe())
      assert.strictEqual((yield* post("bounced")).status, 202)
      assert.strictEqual(yield* Fiber.join(waiting), "delivered")
      assert.strictEqual(attempts, 2)
    }).pipe(Effect.provide(app), Effect.scoped, Effect.timeout("3 seconds"))
  })

  it.effect("multipart containers omit base64 encoding while their leaf parts retain it", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare({ ...message, html: "<p>Body</p>" }, { from: input.defaultFrom })
      const mime = new TextDecoder().decode(yield* buildMime(prepared))
      const headers = mime.split("\r\n\r\n")[0]!
      assert.include(headers, "Content-Type: multipart/alternative")
      assert.notInclude(headers, "Content-Transfer-Encoding:")
      assert.strictEqual((mime.match(/Content-Transfer-Encoding: base64/g) ?? []).length, 2)
      const single = yield* prepare(message, { from: input.defaultFrom })
      assert.include(new TextDecoder().decode(yield* buildMime(single)).split("\r\n\r\n")[0]!, "Content-Transfer-Encoding: base64")
    }))
})

