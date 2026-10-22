# Deploying effect-email with alchemy.run

This example deploys a Cloudflare Worker with an `alchemy.run` Stack and sends
mail through a Cloudflare `send_email` binding using the
`CloudflareEmailService` transport.

## Prerequisites

- A Cloudflare account with Email Service/Email Routing enabled for your sender
  domain.
- A verified destination address for the binding.
- Alchemy configured for Cloudflare (`bunx alchemy configure` or
  `CLOUDFLARE_API_TOKEN`).

## Configure

1. Build the local package from the repository root:

   ```sh
   bun install
   bun run build
   ```

2. Edit `src/email.ts` and replace the example sender/destination:

   ```ts
   export const SENDER = "bot@yourdomain.com"
   export const DESTINATION = "you@example.com"
   ```

3. Install the example dependencies:

   ```sh
   cd examples/alchemy
   bun install
   ```

## Run locally

```sh
bun run dev
```

Under `alchemy dev`, the binding writes messages to Alchemy's local email
simulator instead of delivering them.

## Deploy

```sh
bun run deploy
```

The Stack output prints the Worker URL. Test it with:

```sh
curl -X POST "$WORKER_URL/send" \
  -H 'content-type: application/json' \
  -d '{"subject":"Hello","text":"Sent through effect-email and alchemy.run."}'
```

## What the example shows

- `alchemy.run.ts` defines the Stack, Cloudflare providers, state, and Worker.
- `src/email.ts` declares a restricted `send_email` binding.
- `src/worker.ts` obtains the raw binding through `Cloudflare.Email.Send`,
  wraps it with `CloudflareEmailService.make`, and uses the normal
  `Email.layer` / `Email.send` API.

The Worker keeps the Effect service and layer graph in the construction phase
and sends one email per request.
