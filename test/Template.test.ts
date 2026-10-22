import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import * as Email from "../src/Email"
import * as Mock from "../src/providers/Mock"
import * as Template from "../src/render/Template"

class Greeting extends Context.Service<Greeting, string>()(
  "@effect-email/test/Greeting"
) {}

const serviceDefinition: Template.AnyTemplateDefinition<Greeting> = {
  id: "service",
  version: "1",
  props: Schema.Struct({}),
  render: () =>
    Effect.map(Greeting, (prefix) => ({ text: `${prefix} Ada` }))
}

const definition: Template.AnyTemplateDefinition = {
  id: "welcome",
  version: "1",
  props: Schema.Struct({ name: Schema.NonEmptyString }),
  render: (props: { readonly name: string }) =>
    Effect.succeed({
      text: `Welcome ${props.name}`,
      html: `<p>Welcome ${props.name}</p>`
    })
}

describe("Template", () => {
  it.effect("renders a local template before provider submission", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make([definition])
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport },
        renderer
      })

      yield* Email.send({
        to: "customer@example.com",
        subject: "Welcome",
        template: {
          id: "welcome",
          version: "1",
          props: { name: "Ada" }
        }
      }).pipe(Effect.provide(layer))

      const messages = yield* client.inbox.messages
      const content = messages[0]?.message.content
      assert.strictEqual(content?._tag, "rendered")
      assert.strictEqual(
        content?._tag === "rendered" && content.text,
        "Welcome Ada"
      )
      assert.strictEqual(
        content?._tag === "rendered" && content.html,
        "<p>Welcome Ada</p>"
      )
    }))

  it.effect("reports a missing template as a template error", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make([])
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport },
        renderer
      })

      const result = yield* Effect.result(
        Email.send({
          to: "customer@example.com",
          subject: "Welcome",
          template: { id: "missing", version: "1" }
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "TemplateError"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("rejects props that do not match the template schema", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make([definition])
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport },
        renderer
      })

      const result = yield* Effect.result(
        Email.send({
          to: "customer@example.com",
          subject: "Welcome",
          template: {
            id: "welcome",
            version: "1",
            props: { name: "" }
          }
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(
        result._tag === "Failure" && result.failure._tag,
        "TemplateError"
      )
      assert.strictEqual((yield* client.inbox.messages).length, 0)
    }))

  it.effect("derives predictable text from HTML when enabled", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make(
        [
          {
            id: "html-only",
            version: "1",
            props: Schema.Struct({}),
            render: () =>
              Effect.succeed({
                html: "<h1>Hello</h1><p>One &amp; two</p>"
              })
          }
        ],
        { textFallback: true }
      )
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport },
        renderer
      })

      yield* Email.send({
        to: "customer@example.com",
        subject: "Fallback",
        template: { id: "html-only", version: "1" }
      }).pipe(Effect.provide(layer))

      const content = (yield* client.inbox.messages)[0]?.message.content
      assert.strictEqual(content?._tag, "rendered")
      assert.strictEqual(
        content?._tag === "rendered" && content.text,
        "Hello\nOne & two"
      )
    }))

  it.effect("does not throw on out-of-range numeric entities", () =>
    Effect.sync(() => {
      assert.doesNotThrow(() =>
        Template.defaultHtmlToText("<p>&#x110000;</p>")
      )
      assert.strictEqual(
        Template.defaultHtmlToText("<p>&#x110000;</p>"),
        "&#x110000;"
      )
    }))

  it.effect("supports a renderer that requires a service", () =>
    Effect.gen(function* () {
      const client = yield* Mock.makeClient()
      const renderer = yield* Template.make([
        serviceDefinition
      ]).pipe(Effect.provide(Layer.succeed(Greeting, "Hello")))
      const layer = Email.layer({
        defaultFrom: "billing@example.com",
        routes: { default: client.transport },
        renderer
      })

      yield* Email.send({
        to: "customer@example.com",
        subject: "Service",
        template: { id: "service", version: "1" }
      }).pipe(Effect.provide(layer))

      const content = (yield* client.inbox.messages)[0]?.message.content
      assert.strictEqual(
        content?._tag === "rendered" && content.text,
        "Hello Ada"
      )
    }))
})
