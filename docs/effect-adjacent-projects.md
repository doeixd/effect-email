# Effect-Adjacent Projects: auth, payments, infra, DB, agents (researched 2026-09-16)

Companion to [effect-ecosystem.md](effect-ecosystem.md), [effect-schema.md](effect-schema.md) and [unjs-ecosystem.md](unjs-ecosystem.md). Effect v4 = `effect@4.0.0-rc.115`.

## Summary
| Project | What | Effect status | Stack fit |
|---|---|---|---|
| **Alchemy v2** (alchemy-run/alchemy, `alchemy@2.0.0-beta.77`) | Infrastructure as Effects: a Stack of resources you `yield*`; resource logic is Layers; bindings wire permissions, env vars and typed clients; CLI deploy/plan/destroy/drift/dev | **Native v4** (≥rc.112) | IaC for CF/AWS (plus Fly, Hetzner, Railway, Neon, PlanetScale examples). v1 = `alchemy-async` / `alchemy@0.94` |
| **distilled** (`@distilled.cloud/*` 1.0.0-rc.9) | ~85 Effect-native cloud SDKs with typed errors | Native v4 | Most likely Alchemy's SDK layer (unconfirmed) |
| **Drizzle ORM** (`drizzle-orm@rc` 1.0.0-rc.4) | Subpaths `effect-postgres`, `effect-d1`, `effect-sqlite-*`, `effect-core`, `effect-schema` (`createSelect/Insert/UpdateSchema`) | **Native v4** (≥beta.83) | `make`/`makeWithDefaults` needs `PgClient` from `@effect/sql-pg`; queries are yieldable; errors `EffectDrizzleQueryError`, `EffectTransactionRollbackError`; wrap in your own Context.Service |
| **OpenCode** (anomalyco/opencode, 208k★) | AI coding agent built with Effect; plugin API at `@opencode-ai/plugin/v2/effect` (`define({ id, effect })`, scoped hooks) | v4 (beta.83 pinned) | Write OpenCode plugins as Effects. `effect-drizzle-sqlite` and `effect-sqlite-node` are unpublished workspace packages |
| **better-auth** (`better-auth@1.7.5`, 30k★) | Framework-agnostic auth: plugins, DB adapters, one handler plus typed API | None official; community `better-auth-effect` and `effect-better-auth` are **v3 only** | Wrap `auth.api.*` in a service using `Effect.tryPromise` and mount `auth.handler` in HttpRouter; use the Drizzle adapter over the same DB |
| **PayKit** (getpaykit/paykit, `paykitjs@0.1.6`, 1k★) | Stripe billing framework in better-auth style: plans and features in code, entitlements, metering, webhooks, your Postgres | None | Wrap as a service. Alternative: `@paykit-sdk/core` (Stripe/Polar/PayPal unified) |
| **celld** (denoland/celld, 4.7k★, v0.5.0, Rust) | Self-hosted distributed Durable Objects: runs Workers apps from `wrangler.json` (DO, KV, Queues, D1, R2, Workflows, Cron); SQLite cells, state in your S3/GCS/Azure bucket | None (runtime) | Self-host target for effect-cf / Alchemy Worker apps (untested) |
| **Rivet** (`@rivetkit/effect` 2.3.17) | Actors | v4 (≥beta.66) | Stateful actors |
| **Confect** (rjdellecese/confect) | Convex + Effect | 9.x v3; **10.0.0-next.22 v4** (rc.115) | Convex backends |
| Temporal / Inngest / Hatchet | No official packages; community `@springbird/effect-temporal` (v4), `effect-inngest`, `effect-hatchet` | see effect-ecosystem.md | — |
| Prisma, Kysely, Hono, Elysia, TanStack, Electric, Zero, Trigger.dev, Vercel AI SDK | No official Effect packages found (UNVERIFIED; only npm names were guessed) | Use Standard Schema (Elysia/Hono/TanStack) or community libs | Elysia example is in effect-schema.md |

**A plausible v4 stack from these:** Alchemy (infra) + effect-cf (Workers) + Drizzle `effect-d1`/`effect-postgres` + better-auth and PayKit wrapped as services + HttpApi/Rpc + Atom on the client. Example starters: brandhaug/b2b-saas-starter, SeanningTatum/cf-saas-starter-react-router (CF + D1 + Better Auth + Effect).

---

## Details: adj-infra-db-tools

## Effect-TS integrations: infra / DB / tooling (as of 2026-09-16)

Reference: `effect` dist-tags: latest 3.22.2, rc **4.0.0-rc.115**, beta 4.0.0-beta.107.

### 1. Alchemy v2 — "Infrastructure as Effects"

| | |
|---|---|
| Repo | https://github.com/alchemy-run/alchemy — 1,259 stars, pushed 2026-09-16 |
| npm | `alchemy` latest **2.0.0-beta.77** (next 2.0.0-beta.72); bin `alchemy` |
| Effect | peer `effect >=4.0.0-rc.112 \|\| >=4.0.0` (also `@effect/platform-node/bun`, `@effect/sql-pg`, `@effect/sql-mysql2` same range; `drizzle-orm`/`drizzle-kit` 1.0.0-rc.5-ab785fc) |
| v1 | https://github.com/alchemy-run/alchemy-async — 2,211 stars, pushed 2026-08-01; the old v1 line is published as `alchemy` 0.x (last 0.94.0, 2026-08-01). Docs at v1.alchemy.run |
| Status | README: "alpha. Expect breaking changes." Install: `bun add alchemy@latest effect@rc` |

**Architecture**
- A **Stack** (`Alchemy.Stack(name, { providers, state }, Effect.gen(...))`) is the default export of `alchemy.run.ts`. Resources are values (`Cloudflare.R2.Bucket("id")`); you `yield*` them to get outputs.
- **Providers** implement the resource lifecycle (reconcile, delete, diff, read) **as Effect Layers**. You write custom providers by declaring a Resource type plus a Layer.
- **Bindings** connect a resource to a Worker or Lambda. One call (for example `Cloudflare.R2.ReadWriteBucket(Bucket)` or `S3.GetObject(bucket)`) sets up the IAM policy or binding, the env var, and a typed runtime client. Infrastructure and runtime code live in one Effect program.
- Cloud API failures come back as **tagged Effect errors**. Auth providers resolve credentials lazily as Effects.
- **State store:** keeps resource state between deploys. For example `Cloudflare.state()` is backed by a state-store Worker that you set up with `alchemy cloudflare` bootstrap. Docs: alchemy.run/state-store.
- **CLI:** `deploy`, `plan` (= deploy --dry-run), `destroy`, `drift`, `nuke`, `dev` (hot reload, local Worker runtime), `logs`, `profile`, `state`, `aws` (bootstrap assets bucket), `cloudflare` (state-store worker, tokens). Also: `--adopt` for adopting existing resources, and a GitHub Action `alchemy-run/alchemy@v1` for prod and PR previews.
- **Providers:** the README says "AWS + Cloudflare today" (S3, SQS, DynamoDB, Kinesis, Lambda, EC2, ECS, EKS, RDS, Bedrock / Workers, R2, D1, DO, Containers, Email, Secrets Store). The examples folder also covers Fly.io, Hetzner, Railway, Prisma (Postgres/Compute), Neon, PlanetScale, Docker. Monorepo packages: `alchemy`, `alchemy-test`, `better-auth`, `cloudflare-runtime`, `cloudflare-test-tools`, `frontend-frameworks` (peer `@alchemy.run/frontend-frameworks`), `node-utils`, `pr-package`, `floci`.

```ts
// README
const Bucket = Cloudflare.R2.Bucket("bucket");
export default Cloudflare.Worker("api", { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    return { fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const object = yield* bucket.get(request.url);
      return HttpServerResponse.stream(object!.body);
    }) };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)));

// Stack (docs: migrating-from-v1)
export default Alchemy.Stack("MyApp",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () { const worker = yield* Worker; return { url: worker.url }; }));
```

**Migration from v1:** replace `await alchemy(...)` / `app.finalize()` with an exported `Alchemy.Stack`, and `await Resource(...)` with `yield*`. Resources are imported from `alchemy/Cloudflare` (PascalCase modules). Existing `async fetch` handlers can stay as they are.

#### distilled (Effect-native cloud SDKs)
- Repo https://github.com/alchemy-run/distilled — 416 stars, pushed 2026-09-16. Same maintainers (sam-goodwin, pear-alchemy).
- npm `@distilled.cloud/*` **1.0.0-rc.9** (2026-09-09), peer `effect >=4.0.0-rc.112`. `@distilled.cloud/core` holds the client factory, HTTP trait annotations, error classes and categories, pagination, and retry policies.
- ~85 package dirs: aws, cloudflare, gcp, azure, neon, planetscale, supabase, turso, stripe, vercel, fly-io, github, inngest, temporal, trigger-dev, posthog, sentry, etc. Some are placeholders, for example `@distilled.cloud/doppler` ("Placeholder package for an upcoming distilled SDK").
- These are the generated, typed-error SDKs that Alchemy v2 providers are built on. This relationship is inferred from the shared org, maintainers and peer range, not confirmed in docs.
- There is also a third-party fork, `@kevinmichaelchen/distilled*` 0.2–0.3 ("Effect 4-native ... generated by Distilled").

### 2. Drizzle ORM — Effect integration (built into `drizzle-orm`)

| | |
|---|---|
| Repo | https://github.com/drizzle-team/drizzle-orm — 35,787 stars, pushed 2026-09-16 |
| npm | `drizzle-orm` latest 0.45.2, beta 1.0.0-beta.22, **rc 1.0.0-rc.4** (Alchemy pins 1.0.0-rc.5-ab785fc). Old dist-tags `effect`, `effect3`, `drizzle-effect`, `effect-fixes` etc. show how the work progressed |
| Separate pkg? | **No.** `@drizzle-team/effect` does not exist (404). `drizzle-effect` was an unrelated package, unpublished 2025-04-23. `drizzle-orm/effect` is not an export. Everything ships as subpaths of `drizzle-orm` |
| Effect | optional peers `effect >=4.0.0-beta.83 \|\| >=4.0.0` plus `@effect/sql-{pg,d1,libsql,mysql2,pglite,sqlite-do,sqlite-bun,sqlite-node,sqlite-wasm}` with the same range. **Effect v4 only** |

**Exports (rc.4):**
- Drivers, each with `driver`, `session` and `migrator` (Postgres-family and mysql2 also have `codecs`): `./effect-postgres`, `./effect-pglite`, `./effect-mysql2`, `./effect-d1` (driver/session only), `./effect-libsql`, `./effect-sqlite-bun`, `./effect-sqlite-node`, `./effect-sqlite-do`, `./effect-sqlite-wasm`.
- `./effect-core` (errors, logger, defaults, query-effect).
- `./effect-schema` (`createSelectSchema`, `createInsertSchema`, `createUpdateSchema`, which produce `effect/Schema`).
- Dialect cores: `pg-core/effect` and so on.

**API, from the .d.ts files:**
- **Relation to @effect/sql:** Drizzle does not own the connection. `make(config?)` returns `Effect<EffectPgDatabase<TRelations> & { $client: PgClient }, never, EffectCache | EffectLogger | PgClient>`, and `PgClient` comes from `@effect/sql-pg/PgClient`. `makeWithDefaults(config?)` needs only `PgClient`. `DefaultServices` provides a no-op logger and cache. `EffectLogger.layer` logs through Effect, and `EffectLogger.layerFromDrizzle(logger)` wraps a Drizzle logger.
- **Queries are Effects:** query builders are yieldable. The query HKT sets `error: EffectDrizzleQueryError` and `context: never`, so `yield* db.select()...` gives `Effect<Rows, EffectDrizzleQueryError>`.
- **Errors** (Schema tagged, yieldable): `EffectDrizzleError {message, cause}`, `EffectDrizzleQueryError {query, params, cause}`, `EffectTransactionRollbackError`, `MigratorInitError {exitCode: "databaseMigrations"|"localMigrations"}`. Transactions can also fail with `SqlError` from @effect/sql.
- **Transactions:** `db.transaction(tx => Effect<A,E,R>): Effect<A, E | SqlError, R>`.
- **Wrapping as a service:** there is no built-in Service or Layer class. Wrap `make` in your own `Context.Service` / `Layer.effect`.

```ts
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { PgClient } from "@effect/sql-pg";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Context, Effect, Layer } from "effect";

class Db extends Context.Service<Db>()("Db", {
  make: PgDrizzle.makeWithDefaults({ relations }),   // requires PgClient
}) {}
const DbLive = Layer.effect(Db, Db.make).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })));

const UserSchema = createSelectSchema(users);          // effect/Schema

const program = Effect.gen(function* () {
  const db = yield* Db;
  const rows = yield* db.select().from(users);          // Effect<..., EffectDrizzleQueryError>
  yield* db.transaction((tx) => tx.insert(users).values({ name: "a" }));
  return rows;
}).pipe(Effect.catchTag("EffectDrizzleQueryError", (e) => Effect.die(e)));
```
(In Effect v4 the service-class API was renamed. Check the exact `Context.Service` / `PgClient.layer` signatures against rc.115. The `make`/`makeWithDefaults`, error, and `transaction` signatures above come straight from the package's .d.ts.)

### 3. OpenCode — Effect plugin API

| | |
|---|---|
| Repo | https://github.com/anomalyco/opencode (formerly sst/opencode) — 207,809 stars, pushed 2026-09-16 |
| npm | `@opencode-ai/plugin` **1.18.31**, deps `effect: 4.0.0-beta.83` (pinned), `@opencode-ai/sdk` 1.18.31, `zod` 4.1.8, `@ai-sdk/provider`. `@opencode-ai/sdk` 1.18.31 does not depend on Effect |
| Separate effect pkg? | `@opencode-ai/effect` does not exist (404). Effect ships as subpath exports of the plugin: `@opencode-ai/plugin/v2/effect`, `/v2/effect/plugin`, `/v2/effect/integration` (alongside `/v2/promise`) |
| Private Effect workspace pkgs | `@opencode-ai/effect-drizzle-sqlite` (exports `./effect-sqlite`, `./effect-sqlite/migrator`, `./sqlite-core/effect`, a Drizzle+@effect/sql-sqlite-bun adapter) and `@opencode-ai/effect-sqlite-node`. Both are `private: true` and unpublished. Other packages in the monorepo: core, server, httpapi-codegen, protocol, schema, sdk-next, llm, session-ui, etc. The core app is built on Effect |

**V2 Effect plugin API** (packages/plugin/src/v2/effect/README.md):
- `define({ id, effect: Effect.fn(function* (ctx) {...}) })`. Setup registers hooks imperatively, and plugin config is available as `ctx.options`.
- Registrations are tied to the plugin **scope**: closing the scope removes them automatically, or `dispose` removes one early.
- **Transform hooks** rebuild domain state: `ctx.agent|catalog|command|integration|reference|skill.transform`.
- **Runtime hooks** intercept live operations, for example `ctx.aisdk.sdk(...)` and `ctx.aisdk.language(...)`.
- `reload` reruns the transforms.
- Source modules: plugin, event, filesystem, npm, integration, registration.

```ts
import { define } from "@opencode-ai/plugin/v2/effect"
import { Effect } from "effect"
export const Plugin = define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (p) => { p.name = "Example" })
    })
  }),
})
```

### Other Effect integrations ("etc.")

| Project | Finding | Effect |
|---|---|---|
| Rivet (rivet-dev/actors, formerly rivet-dev/rivet) — 6,138 stars, pushed 2026-09-16 | **`@rivetkit/effect` 2.3.17** (tracks the rivetkit version); lives in `rivetkit-typescript/packages/effect` | peer `effect ^4.0.0-beta.66` |
| Confect (Convex + Effect), https://github.com/rjdellecese/confect — 362 stars, pushed 2026-09-15 (community project; `get-convex/confect` does not exist) | `@confect/core` / `@confect/server` latest 9.4.3; `@confect/core@next` 10.0.0-next.22 | 9.x: `effect ^3.21.2`; 10.0.0-next: **`effect ^4.0.0-rc.115`** |
| Drizzle / Alchemy / distilled / OpenCode | see above | v4 |
| Inngest | `@inngest/effect`, `@inngest/effect-sdk`: 404. Distilled has an `inngest` SDK dir (API client, not the Inngest SDK) | UNVERIFIED |
| Temporal | `@temporalio/effect`: 404. Only a distilled `temporal` package | UNVERIFIED |
| Trigger.dev | `@trigger.dev/effect`: 404. Only a distilled `trigger-dev` package | UNVERIFIED |
| Prisma | `@prisma/effect`: 404. Alchemy has a `prisma-compute-effect` example and distilled has `prisma-postgres` | UNVERIFIED as a first-party Prisma package |
| Kysely | `kysely-effect`: 404 | UNVERIFIED |
| Hono / Elysia | `hono-effect`, `elysia-effect`: 404 | UNVERIFIED |
| TanStack | `@tanstack/effect`: 404. Alchemy has `tanstack-rpc-drizzle` examples | UNVERIFIED |
| Electric / Zero | `@electric-sql/effect`, `@rocicorp/zero-effect`: 404 | UNVERIFIED |
| Vercel AI SDK | nothing first-party found. Effect's own `@effect/ai-*` (for example `@effect/ai-anthropic` 0.27.0, v3 line) exists; OpenCode's plugin bridges AI SDK through Effect hooks | UNVERIFIED |

Not checked in depth: GitHub code search for Effect in Inngest, Temporal and TanStack repos. The package names above were guesses, so a 404 does not prove no integration exists.

## Details: adj-auth-pay

## Auth / Pay / celld: adjacent projects (as of 2026-09-16)

Reference Effect: effect@4.0.0-rc.115 (v4). None of the projects below has first-class Effect v4 support.

### 1. better-auth

- Repo: https://github.com/better-auth/better-auth (MIT). About 29,973 stars. Last push 2026-09-16.
- npm: `better-auth@1.7.5`. It builds on `@better-auth/core@1.7.5` and ships separate adapter packages: `@better-auth/{kysely,drizzle,prisma,mongo,memory}-adapter@1.7.5`. Its dependencies include `better-call@1.4.0` (typed endpoint router), `@better-fetch/fetch`, `kysely`, `zod@^4`, `jose`, `@noble/*` and `nanostores`. It has no Effect dependency.
- What it is: a framework-agnostic auth library for TypeScript. You call `betterAuth({ database, emailAndPassword, socialProviders, plugins })` and get an `auth` object with `auth.handler(Request): Response` (a Web-standard handler you mount at `/api/auth/*`) and a typed server API, `auth.api.getSession({ headers })`. `createAuthClient()` gives a typed client with plugin inference. Plugins add endpoints, schema, hooks and client methods. Well-known plugins (from memory, not re-checked for 1.7.5; UNVERIFIED): organization/teams, two-factor, passkey, magic link, email OTP, username, admin, API key, JWT/JWKS, OIDC provider, MCP, SSO, anonymous, multi-session, and Stripe/Polar billing. It has framework helpers for Next.js, SvelteKit, SolidStart, Nuxt, Hono, Express, Elysia and others.
- Organization status: there is a company behind it (Better Auth Inc., YC-backed, with a hosted "Better Auth Infrastructure" dashboard). UNVERIFIED, from memory.
- Effect fit: better-auth has no official Effect integration. The usual pattern is to wrap the `auth` instance in an Effect service or Layer, forward `/api/auth/*` to `auth.handler` from an `HttpRouter` route, and write `HttpApiMiddleware` that calls `auth.api.getSession` through `Effect.tryPromise` and provides a `CurrentUser` tag. Community packages:
  - `better-auth-effect@0.4.1` (repo alex-golubev/better-auth-effect-adapter, 1 star, last push 2026-03). It is a better-auth database adapter backed by `@effect/sql` (pg, mysql2, sqlite) and takes a `runtime` from `Effect.runtime<SqlClient>()`. Peer dependencies are `effect >=3.15`, `@effect/sql >=0.49` and `better-auth >=1.2`, so it targets v3. On v4, `@effect/sql` was folded into `effect/sql`, so it would need a port (UNVERIFIED that it works on v4).
  - `effect-better-auth@0.1.0` (repo kattsushi/better-auth-effect, 0 stars, last push 2025-11). It provides an `Auth` service, a `BetterAuthRouter` for `HttpLayerRouter`, and an AuthContext middleware pattern. Peer dependencies are `effect ^3.18` and `@effect/platform ^0.92`, so it is v3 only and stale.
  - Example app: SeanningTatum/cf-saas-starter-react-router (Cloudflare Workers, D1, Drizzle, Better Auth and Effect).

### 2. "celld": identified as denoland/celld

- Repo: https://github.com/denoland/celld. Site https://celld.dev. Written in Rust. About 4,692 stars. Created 2025-04, last push 2026-09-15, latest release v0.5.0. It has no npm package.
- What it is: "Self-hosted, distributed Durable Objects" from Deno. It is an open-source daemon that runs Cloudflare Workers apps on your own machines, deployed from your existing `wrangler.json`. It supports Workers (fetch handlers, service bindings, JS RPC, nodejs compat), Durable Objects (SQLite storage, alarms, hibernating WebSockets), KV, Queues, D1, R2, Workflows, Cron Triggers, static assets, and, experimentally, Containers and Sandboxes. Each object is a "cell": a named server with its own SQLite database. Long-term state lives in a bucket you own (S3, GCS or Azure). A conditional bucket write gives a node ownership of a cell, so it needs no consensus service or membership protocol. Committed SQLite writes are shipped as LTX replication data, either to one or two peer nodes (faster durability) or to the bucket. Each node embeds V8.
- Effect fit: the repo does not use Effect (code search found only Rust "side effect" and `Effect` enums). It sits at the infrastructure layer. An Effect app that targets Cloudflare Workers or Durable Objects, for example one deployed with alchemy or `@effect/platform` on Workers, should run unchanged on celld, giving a self-hosted or portable deploy target. UNVERIFIED: no Effect-on-celld example was found.

### 3. "paykit": two TypeScript candidates

#### 3a. getpaykit/paykit (most likely the intended one)
- Repo: https://github.com/getpaykit/paykit. Site https://paykit.sh. About 1,050 stars. Created 2026-02, last push 2026-09-14. Top contributors are maxktz and tedbrine.
- npm: `paykitjs@0.1.6` (npm modified 2026-06-23; the repo has moved on since). Its dependencies are `stripe@^19`, `drizzle-orm`, `pg`, `better-call@^2`, `@better-fetch/fetch`, `zod@^4`, `pino` and a CLI (commander, clack). It has no Effect dependency.
- What it is: an embedded Stripe billing framework, clearly styled after better-auth (it uses better-call and better-fetch). It runs inside your app, stores billing state in your Postgres database through Drizzle, and handles webhooks for you. API shape: `feature({ id, type: "metered" })`, then `plan({ id, group, default, price: { amount, interval }, includes: [messages({ limit, reset: "month" })] })`, then `createPayKit({ stripe: { secretKey, ... }, plans, ... })`. Plans are defined in code and synced to Stripe, and you get entitlement checks, usage tracking and subscriptions. It supports Stripe only.
- Effect fit: wrap `paykit` in an Effect service, route the webhook handler through `HttpRouter`, and call entitlement checks with `Effect.tryPromise`. It pairs naturally with better-auth for user and org identity (UNVERIFIED whether it ships a better-auth plugin).

#### 3b. payrouteshq/paykit-sdk ("usepaykit")
- Repo: https://github.com/payrouteshq/paykit-sdk. Site https://usepaykit.dev. 67 stars. Last push 2026-09-04. Part of the Vercel OSS program.
- npm: `@paykit-sdk/core@1.3.4`, plus `@paykit-sdk/{stripe,polar,paypal,react,ui,registry}`.
- What it is: a unified, provider-agnostic payments SDK. One API covers Stripe, Polar and PayPal, and you can write custom providers. It also has shadcn-registry installers (for example `npx shadcn add https://usepaykit.dev/r/stripe-hono`). It has no Effect dependency.

#### Others (not relevant)
cashapp/cash-app-pay-android-sdk (the Cash App "PayKit" Android SDK), argcast/paykit (a small Stripe toolkit), pubky/paykit-rs (Rust), and several mobile-money or Alipay repos.

### Summary for an Effect stack
- None of these depends on Effect. All are Promise and Web-Request based, so integrating them means thin wrappers: Layer and service, `Effect.tryPromise`, route forwarding, plus HttpApi middleware for sessions.
- The only Effect adapters for better-auth are small community packages that target Effect v3. Expect to write your own for v4.
- celld is a self-hosted runtime for Workers and Durable Objects. It is useful as a deploy target and does not affect code-level integration.
