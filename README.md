# effect-email

**Effect-native transactional email for TypeScript.** Typed messages, durable
delivery, provider adapters, retry and fallback policies, SMTP, HTTP admission,
workflows, and suppression, built on Effect v4.

[![npm](https://img.shields.io/npm/v/@doeixd/effect-email)](https://www.npmjs.com/package/@doeixd/effect-email)
[![license](https://img.shields.io/npm/l/@doeixd/effect-email)](LICENSE)
[![Effect v4](https://img.shields.io/badge/Effect-v4-5A45FF)](https://effect.website)

An independent Effect port of [unemail](https://github.com/productdevbook/unemail).
See [`NOTICE`](./NOTICE) for upstream attribution.

## Why effect-email

- **Typed end to end.** Message input, normalized drafts, receipts, errors,
  capabilities, and batch outcomes are schemas and Effect services.
- **Safe by default.** CRLF/header injection checks, redacted credentials,
  redacted error causes, deny-by-default gateway authorization, request limits,
  SMTP authentication, and suppression.
- **Durable when you need it.** Delivery intents, SQL-backed queues and stores,
  outbox recovery, cancellation tombstones, retention, stale-work reconciliation,
  and workflow timers.
- **Composable policies.** Retry, fallback, round-robin, tee mirroring, rate
  limiting, and circuit breaking share one transport contract.
- **Broad provider coverage.** 24 external adapters plus a local Mock provider,
  with optional native batches and receipt-routed retrieval/cancellation.
- **One package, explicit subpaths.** The root entrypoint is free of Node-only
  code; providers and server bindings are opt-in imports.

## Install

```sh
bun add @doeixd/effect-email effect
# or
npm install @doeixd/effect-email effect
```

Node 22 or newer is required for the Node HTTP and SMTP bindings.

## Quick start

The Mock provider needs no credentials or network access:

```ts
import { Effect } from "effect"
import * as Email from "@doeixd/effect-email/Email"
import * as Mock from "@doeixd/effect-email/providers/Mock"

const program = Effect.gen(function* () {
  const client = yield* Mock.makeClient()
  const emailLayer = Email.layer({
    defaultFrom: "billing@example.com",
    routes: { default: client.transport }
  })

  const receipt = yield* Email.send({
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your order."
  }).pipe(Effect.provide(emailLayer))

  const messages = yield* client.inbox.messages
  return { receipt, messages }
})

const { receipt, messages } = await Effect.runPromise(program)
console.log(receipt.providerMessageId, messages.length)
```

Run it locally:

```sh
bun examples/quick-start.ts
```

More in [`examples/`](./examples), including a
[Cloudflare Worker deployment with alchemy.run](./examples/alchemy).

## Deploy with alchemy.run

The [`examples/alchemy`](./examples/alchemy) example deploys a Cloudflare Worker
with an Alchemy Stack and a restricted `send_email` binding:

```ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import Worker from "./src/worker.ts"

export default Alchemy.Stack(
  "EffectEmailAlchemyExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function* () {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
```

The Worker wraps Alchemy's raw email binding with
`CloudflareEmailService.make`, then uses the normal `Email.layer` and
`Email.send` API. See the example README for setup, local development, and
deployment commands.
## Send with a provider

```ts
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Email from "@doeixd/effect-email/Email"
import * as Resend from "@doeixd/effect-email/providers/Resend"

const transport = yield* Resend.make({
  apiKey: Redacted.make(process.env.RESEND_API_KEY!)
}).pipe(Effect.provide(FetchHttpClient.layer))

const emailLayer = Email.layer({
  defaultFrom: "billing@example.com",
  routes: { default: transport }
})

const receipt = yield* Email.send({
  to: "customer@example.com",
  subject: "Your receipt",
  text: "Thanks for your order."
}).pipe(Effect.provide(emailLayer))
```

Every adapter follows the same shape: `make(options)` returns a `Transport`, and
`Email.layer({ routes })` turns transports into an `Email` service. Run
`bun examples/resend.ts` with `RESEND_API_KEY` set for a live example.

## Providers

| Provider | Native batch | Notes |
| --- | --- | --- |
| Resend | no | request idempotency, attachments, tags |
| Postmark | yes | message stream, batch error codes |
| SendGrid | yes | personalizations, recipient splitting |
| Mailjet | yes | message versions, partial results |
| MailerSend | yes | bulk email, retrieval |
| Brevo | yes | message versions, hashed idempotency |
| Mailgun | yes | multipart forms, recipient variables |
| SMTP | no | MIME, DKIM, STARTTLS, AUTH PLAIN, pooling |
| SMTP2GO | no | remote attachments, partial results |
| Mailtrap | yes | sandbox/live, categories, templates |
| Mailpit | no | SMTP send and local inbox API |
| Mailcrab | no | SMTP send and local inbox API |
| Scaleway | no | 2 MiB cap, explicit attachment types |
| SES | no | SigV4, raw MIME, tags, configuration set |
| Azure Communication | no | HMAC auth, operation polling |
| ZeptoMail | yes | batch and template endpoints |
| AhaSend | no | per-recipient results, idempotency |
| Loops | no | template-only sends |
| Cloudflare Email REST | no | 50 recipients, 32 attachments |
| Cloudflare Email bindings | no | Workers bindings |
| MailChannels | yes | 1,000 personalizations |
| Mailbreeze | no | provider templates, idempotency |
| Generic HTTP | no | caller-owned request body |
| Mock | yes | scripted failures and inbox assertions |

See [`docs/driver-parity.md`](./docs/driver-parity.md) for the pinned upstream
manifest and exact per-provider behavior.

## Batches and streams

```ts
const outcomes = yield* Email.sendBatch(
  [
    { to: "one@example.com", subject: "One", text: "First" },
    { to: "two@example.com", subject: "Two", text: "Second" }
  ],
  { concurrency: 8 }
).pipe(Effect.provide(emailLayer))

const stream = Email.sendStream(inputStream, {
  chunkSize: 32,
  concurrency: 4
}).pipe(Stream.provide(emailLayer))
```

Batch outcomes are indexed and preserve input order. Failures are isolated per
slot as `accepted`, `rejected`, `uncertain`, or `invalid`. Native batch providers
are chunked by their advertised limit; other providers are dispatched
concurrently.

## Policies

```ts
import * as EmailTransport from "@doeixd/effect-email/EmailTransport"

const routed = EmailTransport.withRoundRobin([primary, secondary])
const resilient = EmailTransport.withRetry({
  maxAttempts: 3,
  jitter: true
})(EmailTransport.withFallback(secondary)(routed))

const limited = yield* EmailTransport.withRateLimit({
  requests: { limit: 10, intervalMillis: 1_000 },
  recipients: { limit: 100, intervalMillis: 1_000 }
})(resilient).pipe(Effect.provide(EmailTransport.layerRateLimiterMemory))
```

Policies compose without changing the transport contract. Retry never replays an
uncertain submission. Fallback only moves rejected, safely retryable slots.
Tee exposes explicit multi-receipt results. Rate limits and circuit breakers are
configurable, with safe handling for oversized requests.

## Templates

```ts
import { Effect, Schema } from "effect"
import * as Template from "@doeixd/effect-email/render/Template"

const welcome = {
  id: "welcome",
  version: "1",
  props: Schema.Struct({ name: Schema.String }),
  render: ({ name }: { readonly name: string }) =>
    Effect.succeed({
      text: `Welcome ${name}`,
      html: `<h1>Welcome ${name}</h1>`
    })
}

const renderer = yield* Template.make([welcome], { textFallback: true })
const emailLayer = Email.layer({
  defaultFrom: "billing@example.com",
  routes: { default: transport },
  renderer
})
```

Rendering happens before capability checks and provider submission. Queue
admission snapshots rendered content so replays do not silently change.

## Durable delivery

```ts
import * as DeliveryStore from "@doeixd/effect-email/DeliveryStore"
import * as Submissions from "@doeixd/effect-email/queue/Submissions"
import * as SubmissionAdmission from "@doeixd/effect-email/SubmissionAdmission"

const admissionLayer = SubmissionAdmission.layer({
  defaultFrom: "billing@example.com"
}).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      DeliveryStore.layerMemory,
      Submissions.layerFactoryMemory,
      Email.layer({ defaultFrom: "billing@example.com", routes: { default: transport } })
    )
  )
)

const receipt = yield* SubmissionAdmission.accept({
  tenantId,
  message: {
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your order."
  }
}).pipe(Effect.provide(admissionLayer))
```

`accept` commits the delivery intent before queueing. Run
`Submissions.runWorker` for processing, `runPublisher` for outbox recovery, and
`reconcileStale` / `runReconciler` for stale in-progress work. SQL equivalents
are available through `DeliveryStoreSql.layerSql` and
`Submissions.layerFactorySql`.

## HTTP gateway

```ts
import { ByteSize } from "effect"
import * as Gateway from "@doeixd/effect-email/server/Gateway"
import * as NodeServer from "@doeixd/effect-email/server/Node"

const handler = Gateway.make({
  authorize: (request) => authorizeCaller(request), // replace with real auth
  verifyEvent: (request, event, rawBody) =>
    verifyProviderSignature(request, event, rawBody),
  maxBodySize: ByteSize.mebibytes(5)
})

const server = yield* NodeServer.serve(handler, {
  host: "127.0.0.1",
  port: 3000
})
```

The gateway serves submission, status, cancellation, redrive, event ingestion,
failed/uncertain listings, diagnostics, and health. **Non-health routes deny by
default**; authorization and provider-event verification must be supplied.
`Catcher.handler` is development-only and also denies by default.

## SMTP

```ts
import { Redacted } from "effect"
import * as Smtp from "@doeixd/effect-email/providers/Smtp"

const transport = yield* Smtp.make({
  host: "smtp.example.com",
  port: 587,
  startTls: true,
  auth: {
    username: "mailer",
    password: Redacted.make(process.env.SMTP_PASSWORD!)
  }
})
```

The SMTP server is a separate Node subpath:

```ts
import * as NodeSmtp from "@doeixd/effect-email/smtp/Node"

const server = yield* NodeSmtp.start({
  port: 2525,
  requireAuthentication: true,
  authenticate: verifySmtpCredentials,
  admit: (submission) => admission.acceptRaw(tenantId, submission)
})
```

SMTP supports implicit TLS, STARTTLS, AUTH PLAIN, pooled connections, bounded
lines/messages/recipients/connections, MIME, and DKIM.

## Workflows

```ts
import { WorkflowEngine } from "effect/workflow"
import * as SubmitWorkflow from "@doeixd/effect-email/workflow/Submissions"

const workflows = Layer.mergeAll(
  SubmitWorkflow.layer,
  SubmitWorkflow.layerSubmitAfterDelay
).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))

const receipt = yield* SubmitWorkflow.SubmitAfterDelay.execute({
  tenantId,
  deliveryId,
  message: {
    to: "customer@example.com",
    subject: "Scheduled receipt",
    text: "Sent later."
  },
  delayMillis: 60_000
})
```

Workflows support durable delays, provider-event waits, event-before-wait,
cancellation tombstones, and resume/interrupt/poll recovery helpers.

## Suppression and retention

```ts
import * as Suppression from "@doeixd/effect-email/Suppression"

const suppressions = yield* Suppression.SuppressionStore
yield* suppressions.suppress({
  tenantId,
  recipient: "bounced@example.com",
  reason: "hard bounce"
})
```

Provide `Suppression.layerMemory` or `Suppression.layerSql` alongside admission
to reject suppressed recipients before work is queued. `DeliveryStore.prune` and
`Spool.prune` provide retention hooks.

## Errors

`EmailError` is a tagged union with explicit certainty and retryability:

```ts
import { certaintyOf, isRetryable } from "@doeixd/effect-email/EmailError"

if (certaintyOf(error) === "unknown") {
  // Do not blindly retry: the provider may have accepted the message.
}
```

Provider credentials and raw HTTP request headers are removed from serialized
error causes.

## Runtime support

| Capability | Node 22+ | Bun | Deno | Workers |
| --- | --- | --- | --- | --- |
| Core, policies, templates, spool | yes | yes | yes | yes |
| HTTP providers | yes | yes | yes | yes |
| SES | yes | yes | no | no |
| SMTP client/server | yes | yes | no | no |
| Node HTTP server | yes | yes | no | no |
| Cloudflare bindings | no | no | no | yes |

See [`docs/runtime-matrix.md`](./docs/runtime-matrix.md) for details.

## Documentation

- [Implementation plan](./effect-email-implementation-plan.md)
- [Driver parity](./docs/driver-parity.md)
- [Runtime matrix](./docs/runtime-matrix.md)
- [PostgreSQL deployment](./docs/postgres.md)
- [Release checklist](./docs/release.md)
- [Review findings](./docs/review-findings.md)
- [Review plan](./docs/review-plan.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

## Development

```sh
bun install
bun run check          # build, typecheck, and tests
bun examples/quick-start.ts
bun run build
bun run smoke
npm pack --dry-run
```

The build emits ESM JavaScript, declarations, and source maps into `dist/`.
Publishing runs `prepack` automatically.

## Security defaults

- Gateway and Catcher deny non-health routes unless authorization is supplied.
- Provider events require an explicit verifier.
- Request bodies are limited by `maxBodySize` (default 10 MiB).
- SMTP authentication is required by default when an authenticator is configured.
- Tags are restricted to header-safe tokens.
- Secrets use `Redacted`; error causes are sanitized.
- Use a trusted ingress and tenant-aware authorization in production.

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
