import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as CloudflareEmailService from "@doeixd/effect-email/providers/CloudflareEmailService"
import * as Email from "@doeixd/effect-email/Email"
import { DESTINATION, EmailBinding, SENDER } from "./email.ts"

export default Cloudflare.Worker(
  "EffectEmailApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const email = yield* Cloudflare.Email.Send(EmailBinding)
    const raw = yield* email.raw
    const transport = yield* CloudflareEmailService.make({
      binding:
        raw as unknown as CloudflareEmailService.CloudflareEmailServiceBinding
    })
    const emailLayer = Email.layer({
      defaultFrom: SENDER,
      routes: { default: transport }
    })

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")

        if (url.pathname === "/healthz") {
          return yield* HttpServerResponse.json({ status: "ok" })
        }

        if (url.pathname !== "/send" || request.method !== "POST") {
          return HttpServerResponse.text("not found", { status: 404 })
        }

        const body = (yield* request.json) as {
          readonly subject?: string
          readonly text?: string
        }
        const result = yield* Email.send({
          to: DESTINATION,
          subject: body.subject ?? "Hello from Alchemy",
          text: body.text ?? "Deployed with alchemy.run."
        }).pipe(
          Effect.provide(emailLayer),
          Effect.match({
            onSuccess: (receipt) => ({
              ok: true as const,
              providerMessageId: receipt.providerMessageId
            }),
            onFailure: (error) => ({
              ok: false as const,
              message: error.message
            })
          })
        )
        return yield* HttpServerResponse.json(result)
      })
    }
  }).pipe(Effect.provide(Cloudflare.Email.SendBinding))
)
