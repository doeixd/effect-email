---
name: effect-ecosystem
description: "Comprehensive Effect-TS ecosystem map (Sept 2026) — official v4 packages, verified community libs (jobs, CF, alchemy, agents, durable streams, SQL, TUI, frontend), TWIE #101–#135 digest"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4793989c-3af5-47bd-98fc-74dfa80756c0
  modified: 2026-09-16T12:41:03.799Z
---

# Effect-TS Ecosystem (researched 2026-09-16)

Companion to [[effect-v4-api-scope]] (core module map). Built from: all This Week in Effect (TWIE) issues #101 (2026-01-16) → #135 (2026-09-07, latest), GitHub/npm verification (stars/push dates as of 2026-09-16), and Marve10s/awesome-effect. Appendices hold the raw per-source harvests.
**Rule:** "v4" = package's effect peer/dep allows 4.x. Current: `effect@latest`=3.22.2, `effect@rc`=4.0.0-rc.115.

## Timeline (v4)
- #106 (Feb 20 2026) v4 Beta — rewritten runtime, ~70kB→~20kB min bundle, unified versioning, packages merged into core.
- #113 `ServiceMap` renamed back to `Context` (breaking). #118 `Effect.Yieldable` removed.
- #127 effect-smol archived; Effect-TS/effect `main` = v4 (v3 on `v3` branch).
- #129 `@effect/platform-deno`; v3→v4 API-diff migration tooling; Ziverge first adoption partner.
- #131 **v4 Release Candidate** (API presumed stable). NodeRedis ioredis→redis.
- #133 core has zero external deps; `@effect/sql-pg` native PgProtocol client (no `pg`); native Arbitrary; pull-based Socket.
- #134 perf pass (~2x memory), ByteSize branded bigint. #135 `Schema.transformOrFail`→`Schema.transformEffect` (breaking); LanguageModel/Chat/Reactivity become interface + Context.Service.
- Milestones: 10M weekly downloads (#114), 14k stars (#116). Recap posts: effect.website/blog/effect-v4beta-launch-to-may-recap, /effect-v4-rc-august-recap. "Module of the Week" blog series started #135.

## Quick triage (what to reach for)
| Need | First choice | Alternatives |
|---|---|---|
| Background jobs/queues | **effect-mq** (TeamWarp, v4) | `effect/persistence` PersistedQueue (official, lighter); effect-inngest, effect-hatchet |
| Durable workflows | `effect/workflow` + `cluster` | **@springbird/effect-temporal** (run Effect workflows on Temporal); effect-golem (Golem Cloud); cevr/effect-encore (actors) |
| Durable streams | **humanlayer/effect-durable-streams** (v4 server for the Durable Streams protocol) + effect-durable-streams-client | durable-streams/durable-streams (upstream, non-Effect) |
| Cloudflare Workers | **effect-cf** (danieljvdm, v4, very active) | jbt95/effect-cf, backpine/effect-worker, aryasaatvik/effect-platform-cloudflare; official `@effect/sql-d1`, `@effect/sql-sqlite-do` |
| IaC / cloud SDKs | **alchemy v2** ("Infrastructure as Effects", v4) + **distilled** (Effect-native CF/AWS SDKs) | floydspace/effect-aws |
| AI / agents | official `effect/ai` + `@effect/ai-{openai,anthropic,openrouter,openai-compat}` | effect-agent (danieljvdm, early), humanlayer/fold (agent core+TUI), effect-uai (betalyra); MCP: `effect/ai` McpServer |
| SQL | `effect/sql` + `@effect/sql-*` driver | **drizzle-orm@rc** `drizzle-orm/effect-postgres` etc. (native v4); effect-qb, effql, effect-prisma-generator |
| Caching | core `Cache`, `ScopedCache`, `RcMap`; `unstable/persistence` PersistedCache, KeyValueStore(.layerSql), RateLimiter(.adaptive) | — |
| Reactivity / client state | `effect/reactivity` (Atom, AsyncResult, AtomRpc, AtomHttpApi) + `@effect/atom-{react,solid,vue}` | effect-query (TanStack Query adapter, v4); effect-atom-svelte; doeixd/effect-atom-jsx; legacy tim-smart/effect-atom (v3) |
| Frontend framework | **Foldkit** (Elm architecture, v4) | TylorS/typed, effect-nextjs, effect-machine / effect-xstate (state machines) |
| TUI / CLI | `effect/cli` | effect-boxes (v4 TUI layout), effect-cli-tui, effective-progress; **motel** (OTel TUI viewer). NOTE: "effect-tui by kitlangton" does NOT exist |
| Testing | `@effect/vitest`, `HttpApiTest`, `RpcTest` | effect-bdd (Gherkin), anomalyco/effect-http-recorder (v4 cassettes), effect-playwright, effect-bun-test |
| Observability | `effect/observability` Otlp | @effect/opentelemetry; motel (local); Effect DevTools (vscode-extension) |
| Agent DX | Effect-TS/skills (official, incl. v3→v4 migration), `@effect/tsgo` / language-service | effect-solutions CLI (kitlangton), EffectPatterns, tim-smart/effect-mcp (docs MCP), llms-effect, oxlint rule plugins (community only) |

## Corrections to the circulating X summary
- effect-tui (kitlangton): no such repo; npm `effect-tui` is unrelated v3.
- effect-react-query: no distinct current package → use effect-query (voidhash) or tiesen243/effect-tanstack-query.
- @akoenig/effect-http-recorder is v3 only; v4 equivalent is anomalyco/effect-http-recorder.
- tanstack-db-atom: tiny, v3, stale.
- awesome-effect repo is Marve10s/awesome-effect. effect-isles = xesrevinu/effect-event-log-isles. shipwright = piotr-m-jurek/shipwright.
- OXLint Effect rules: no official plugin (only community forks); official linting = @effect/tsgo LSP linter.
- effect-solutions MCP mode: unconfirmed (CLI confirmed). procdeck: no effect dep in npm metadata.
- Drizzle native Effect v4: CONFIRMED (drizzle-orm 1.0.0-rc.x subpath exports effect-postgres, effect-d1, effect-sqlite-do, effect-pglite, effect-mysql2, effect-libsql, effect-schema…). `@effect/sql-drizzle` is v3 only.

## Notable apps built on Effect
anomalyco/opencode, pingdotgg/t3code, tim-smart/lalph, Effect-TS/slopcop (CF+Alchemy), dotheyplaytoday (Solid+Effect), shipwright, effect-isles. Starters: brandhaug/b2b-saas-starter (CF/v4/Drizzle D1/Alchemy), foldkit-alchemy-starter, backpine/effect-worker-mono, deracs/create-effect-project.

## People to watch
Kit Langton (effect.solutions, effect.institute, visual-effect, motel, skills), Tim Smart (core; effect-atom, effect-mcp, lalph), danieljvdm (effect-cf, effect-agent), Sam Goodwin (alchemy, distilled), humanlayer (fold, effect-durable-streams), cevr (effect-machine, effect-encore, effect-oxlint), Devin Jameson (Foldkit), Dillon Mulroy, Ziverge (Golem SDK, adoption partner).

---
# Appendices (raw harvests)


## Appendix: ecosystem-packages

## Effect-TS ecosystem packages — verified 2026-09-16

Method: `gh api repos/...` (stars, last push), `npm view` (version, dist-tags, peerDeps/deps on `effect`), and the awesome-effect list (Marve10s/awesome-effect, by Ibrahim Elkamali, updated 2026-09-14).
"v4" = the `effect` range allows 4.x (beta/rc). Current: `effect@latest` 3.22.2, `effect@rc` 4.0.0-rc.115. Stars and dates are as of today.
API descriptions come from the npm/GitHub descriptions and the awesome-list summaries. I did not read the source to check API shapes unless noted.

### Official @effect/* packages (npm)

In v4, most of the old separate packages are part of `effect` itself, each at `effect/<area>`: ai, cli, cluster, devtools, encoding, eventlog, http, http-api, net, observability, persistence, process, reactivity, rpc, schema, socket, sql, workflow, workers. Until 4.0.0 they lived under `effect/unstable/*`; the stable release dropped that segment, though the APIs stay tagged `@stability unstable`.

**Have an `rc` tag (4.0.0-rc.115):**
- Platforms: `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/platform-bun`, `@effect/platform-browser`, `@effect/platform-deno`
- SQL: `@effect/sql-pg`, `@effect/sql-pglite`, `@effect/sql-mysql2`, `@effect/sql-mssql`, `@effect/sql-clickhouse`, `@effect/sql-libsql`, `@effect/sql-d1`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-wasm`, `@effect/sql-sqlite-react-native`, `@effect/sql-sqlite-do` (Durable Objects)
- AI: `@effect/ai-openai`, `@effect/ai-anthropic`, `@effect/ai-openrouter`, `@effect/ai-openai-compat`
- Atom: `@effect/atom-react`, `@effect/atom-solid`, `@effect/atom-vue`. For these, `latest` is 4.0.0-beta.107, peer `effect ^4.0.0-beta.107`.
- Other: `@effect/opentelemetry`, `@effect/vitest`, `@effect/openapi-generator`

**v3 only (no rc tag; merged into core in v4 or dropped):** `@effect/platform`, `@effect/sql`, `@effect/sql-drizzle`, `@effect/sql-kysely`, `@effect/ai`, `@effect/ai-amazon-bedrock`, `@effect/ai-google`, `@effect/rpc`, `@effect/cli`, `@effect/cluster`, `@effect/workflow`, `@effect/experimental`, `@effect/printer(-ansi)`, `@effect/typeclass`.
**Tooling (versioned separately):** `@effect/language-service` 0.87.2, `@effect/tsgo` 0.45.0 (+ per-platform binaries), `@effect/eslint-plugin` 0.3.2, `@effect/docgen`, `@effect/build-utils`.
**Not on npm (404):** `@effect/sql-sqlite-expo`, `@effect/ai-mcp`, `@effect/sql-bun`, `@effect/cloudflare`.
Note: `npm search` returns at most 250 results, so this list may be missing obscure @effect/* names.

---

### Backend / jobs / workflow

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| effect-mq | https://github.com/TeamWarp/effect-mq | `effect-mq` 0.7.0 | 159 | 2026-09-09 | Yes, peer `>=4.0.0-rc <5` |
| effect-temporal | https://github.com/TeamSpringbird/effect-temporal | `@springbird/effect-temporal` 0.5.0 | 21 | 2026-09-11 | Yes, peer `4.0.0-rc.112` (exact) |
| Golem SDK for Effect | https://github.com/golemcloud/effect-golem | `@golemcloud/effect-golem` 1.5.1 | 5 | 2026-08-21 | Yes, dep `4.0.0-beta.98` |
| effect-durable-streams (humanlayer) | https://github.com/humanlayer/effect-durable-streams | not on npm | 16 | 2026-08-31 | v4, according to awesome-effect |
| effect-durable-streams-client | https://github.com/humanlayer/effect-durable-streams-client | not found on npm | 2 | 2026-09-15 | not checked |

- **effect-mq**: background jobs for Effect. You define jobs schema-first, a storage-agnostic queue core feeds a worker runtime, and a Postgres store lives inside your Drizzle schema. The shape is job definitions (Schema payloads), then enqueue, then a worker Layer.
- **effect-temporal**: runs `effect/workflow` programs (Workflow, Activity, DurableClock, DurableDeferred) on a Temporal engine. It also adds durable mailboxes, updates, queryable state, versioning, schedules and Nexus operations. You write standard Effect workflows and swap the engine Layer for Temporal.
- **effect-golem**: lets you write durable Golem agents with Effect. The org is golemcloud (Ziverge). The plain TS SDK `@golemcloud/golem-ts-sdk` 1.1.2 uses decorators (`BaseAgent`, `@agent`) and does not depend on Effect.
- **Durable Streams**: the protocol itself is https://github.com/durable-streams/durable-streams (1694 stars, pushed 2026-09-10, "The data primitive for the agent loop", `@durable-streams/client` 0.2.7, no Effect dependency). The Effect version is humanlayer's: a Durable Streams protocol server written as a portable Effect v4 app with swappable platform Layers.
- Other notable repos from awesome-effect (not individually verified): erikshestopal/effect-inngest, fdarian/effect-hatchet, tim-smart/effect-genserver, cevr/effect-encore (actors and workflows for cluster), `@rivetkit/effect`, CodeForBreakfast/eventsourcing, crosshatch/liminal (actors on Cloudflare).

### Cloudflare / infra

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| alchemy | https://github.com/alchemy-run/alchemy | `alchemy` 2.0.0-beta.77 | 1259 | 2026-09-16 | Yes, peer `>=4.0.0-rc.112` |
| alchemy (legacy async) | https://github.com/alchemy-run/alchemy-async | — | 2211 | 2026-08-01 | n/a |
| distilled | https://github.com/alchemy-run/distilled | `@distilled.cloud/cloudflare` 1.0.0-rc.9 (+ aws) | 416 | 2026-09-16 | Yes, peer `>=4.0.0-rc.112` |
| effect-cf (danieljvdm) | https://github.com/danieljvdm/effect-cf | `effect-cf` 0.44.1 | 99 | 2026-09-16 | Yes, peer `^4.0.0-rc.115` |
| effect-cf (jbt95) | https://github.com/jbt95/effect-cf | not checked | 22 | 2026-08-15 | not checked |
| dmmulroy/effect-cloudflare | https://github.com/dmmulroy/effect-cloudflare | — | 28 | 2025-11-26 | not checked (stale) |
| effect-cloudflare-r2-layer | https://github.com/jpb06/effect-cloudflare-r2-layer | not checked | 8 | 2026-09-15 | not checked |

- **alchemy v2**: "Infrastructure as Effects". Resources are Effect programs, and v2 is built on Effect v4. The original async/await version moved to `alchemy-run/alchemy-async`. Effect-TS/slopcop is deployed with it.
- **distilled**: Effect-native cloud SDKs generated from Smithy and OpenAPI models (Cloudflare: R2, KV, Workers, Queues, Workflows, DNS; also AWS). The older `alchemy-run/distilled-cloudflare` repo (59 stars) was last pushed 2026-01.
- **effect-cf (danieljvdm)**: Effect-native primitives for Cloudflare Workers and bindings. It is the most active CF integration and publishes often.
- Others from the list: aryasaatvik/effect-platform-cloudflare, backpine/effect-worker, nr1brolyfan/effectful-cloudflare, floydspace/effect-aws (211 stars), kondaurovDev/effortless-aws, leonitousconforti/the-moby-effect.

### Frontend / state

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| Foldkit | https://github.com/foldkit/foldkit (foldkit.dev) | `foldkit` 0.160.0 | 851 | 2026-09-16 | Yes, peer `4.0.0-rc.115` (exact) |
| effect-atom (v3) | https://github.com/tim-smart/effect-atom | `@effect-atom/atom(-react)` 0.7.0 | 792 | 2026-08-14 | No, peer `^3.22.1`. v4 successor is `effect/reactivity` + `@effect/atom-*` |
| @effect/atom-solid / -vue / -react | Effect-TS/effect monorepo | see Official | — | 2026-09-11 | Yes |
| effect-query | https://github.com/voidhashcom/effect-query | `effect-query` 1.0.0 | 232 | 2026-09-02 | Yes, peer `^4.0.0-beta.23` |
| effect-react-query | Effect-Community/react (stale 2023, 11 stars). See also tiesen243/effect-tanstack-query | — | — | — | UNVERIFIED as a distinct package |
| tanstack-db-atom | https://github.com/nhattran998/tanstack-db-atom (npm points to harrytran998/tanstack-db-atom) | `tanstack-db-atom` 1.0.0 | 1 | 2026-01-12 | No, dep `effect 3.19.14` |

- **Foldkit**: a frontend framework built on Effect with an Elm architecture (Model, Message, update, view), UI components, a DevTools MCP and SSR. Related: foldkit-alchemy-starter (37 stars), foldcn (shadcn port, 28 stars), foldocs (24 stars).
- **effect-query**: adapter for TanStack Query that builds query and mutation options from Effect RPC and HttpApi clients.
- **tanstack-db-atom**: reactive atoms over TanStack DB collections and queries. Tiny, v3 only, and stale.
- Other v4-tagged entries: sproott/effect-atom-svelte, typeonce-dev/effect-xstate, typeonce-dev/effect-machine (195 stars), TylorS/typed (371 stars), mcrovero/effect-nextjs (149 stars), doeixd/effect-atom-jsx (npm 0.5.0), lucas-barake/effect-form, lucas-barake/effect-local (local-first), typeonce-dev/sync-engine-web (250 stars).

### SQL / data

- **Drizzle and Effect v4**: VERIFIED. `drizzle-orm@rc` (1.0.0-rc.4) has subpath exports `./effect-core`, `./effect-postgres`, `./effect-pglite`, `./effect-mysql2`, `./effect-libsql`, `./effect-d1`, `./effect-sqlite-node`, `./effect-sqlite-bun`, `./effect-sqlite-do`, `./effect-sqlite-wasm` and `./effect-schema`. Its peer deps are `effect >=4.0.0-beta.83 || >=4.0.0` and `@effect/sql-pg` in the same range (optional peers presumably). The old `@effect/sql-drizzle` is v3 only. Repo: https://github.com/drizzle-team/drizzle-orm.
- Official drivers are listed under Official above.
- Others from awesome-effect: relsunkaev/effect-qb, gloomweaver/effql (sqlc-style), eikster-dk/sqlc-gen-better-typescript, m9tdev/effect-prisma-generator (v3 and v4), jmenga/effect-dynamodb, alex-golubev/better-auth-effect-adapter.

### AI / agents

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| effect-agent | https://github.com/danieljvdm/effect-agent | `effect-agent` 0.0.1-beta.3 | 108 | 2026-09-16 | Yes, dep `4.0.0-beta.102` |
| fold | https://github.com/humanlayer/fold | not checked | 70 | 2026-09-15 | Effect-native, version not checked |
| effect-uai | https://github.com/betalyra/effect-uai | `@effect-uai/core` 0.16.0 | 61 | 2026-09-15 | Yes, peer `>=4.0.0-rc.111 <5` |

- **effect-agent**: "agent engine package" by the effect-cf author. Very early beta with no README description.
- **fold**: provider-agnostic, isomorphic agent core with an optional coding agent, CLI and TUI. Supports subagents and RLM-style orchestration.
- **effect-uai**: building blocks for agentic AI, with provider packages. Docs at effect-uai.betalyra.com.
- Other agent and MCP repos: doeixd/affe-agent, mpsuesser/effect-autoagent, kitlangton/rune, acoyfellow/effect-agents, mpsuesser/effect-claudecode, tim-smart/effect-mcp (docs MCP), Kastalien-Research/mcp-effect-sdk. Major apps built with Effect: anomalyco/opencode, pingdotgg/t3code, tim-smart/lalph.

### TUI / CLI

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| @kitlangton/motel | https://github.com/kitlangton/motel | `@kitlangton/motel` 0.2.8 | 290 | 2026-09-02 | Yes, dep `4.0.0-beta.90` |
| effect-tui (kitlangton) | **UNVERIFIED**: no kitlangton/effect-tui repo (404) | `effect-tui` 0.1.0-alpha.1 is a different, unrelated package (placeholder repo URL, v3 `^3.17.13`, 2025-09) | — | — | — |
| effect-devtui | https://github.com/DanielFGray/effect-devtui | — | 17 | 2026-02-28 | not checked |
| procdeck | https://github.com/kondaurovDev/procdeck | `procdeck` 1.1.1 | 1 | 2026-08-28 | npm metadata shows no `effect` dep. awesome-effect says it is built on Effect (probably bundled) |

- **motel**: a local OpenTelemetry ingest server plus TUI viewer for development, stored in SQLite. You point your OTLP exporter at it and browse traces in the terminal.
- **procdeck**: a dev-process multiplexer with a web UI. Each process gets a terminal pane in a browser tab, with declarative dependencies, assigned ports and a `*.localhost` reverse proxy.
- Others: lloydrichards/effect-boxes (v4 TUI layout: Flex, Container, Grid), PaulJPhilp/effect-cli-tui (29 stars), stromseng/effective-progress, davidnussio/envsec.

### Testing

| Item | Repo | npm | Stars | Last push | v4? |
|---|---|---|---|---|---|
| effect-bdd | https://github.com/tatemz/effect-bdd | `effect-bdd` 0.9.1 | 8 | 2026-09-16 | Yes, peer `^4.0.0-rc.112` |
| effect-http-recorder (anomalyco) | https://github.com/anomalyco/effect-http-recorder | `effect-http-recorder` 0.2.2 | 69 | 2026-07-07 | Yes, peer `4.0.0-beta.83` |
| @akoenig/effect-http-recorder | https://github.com/akoenig/effective (monorepo) | `@akoenig/effect-http-recorder` 1.0.6 | 32 | 2025-09-01 | No, peer `^3.16.12` |
| @effect/vitest | Effect-TS/effect | 0.30.0 latest / 4.0.0-rc.115 | — | — | Yes (rc) |

- **effect-bdd**: an Effect-native runner for Gherkin `.feature` files. You bind step definitions as Effects.
- **effect-http-recorder (anomalyco)**: records Effect HttpClient and WebSocket traffic into deterministic JSON cassettes and replays them in tests, provided as a Layer. akoenig's package does the same job for v3.
- Others: cevr/effect-bun-test, Jobflow-io/effect-playwright, `@effect/doctest`.

### DX / tooling / agent skills

| Item | Repo | npm | Stars | Last push | Notes |
|---|---|---|---|---|---|
| Effect LSP | https://github.com/Effect-TS/language-service | `@effect/language-service` 0.87.2 | 421 | 2026-08-10 | tsserver plugin: diagnostics (floating Effects, missing errors in `yield*`, unused layers), quick fixes, refactors |
| @effect/tsgo | https://github.com/Effect-TS/tsgo | `@effect/tsgo` 0.45.0 | 261 | 2026-09-16 | TypeScript-Go with the Effect LSP built in, plus an LSP-based linter. Has Zed and JetBrains plugins |
| Effect-TS/skills | https://github.com/Effect-TS/skills | — (skills.sh) | 97 | 2026-08-27 | Official agent skills, including `effect-v3-to-v4` migration |
| effect-solutions | https://github.com/kitlangton/effect-solutions (effect.solutions) | `effect-solutions` 0.5.3 | 442 | 2026-04-29 | Docs site plus a helper CLI with best-practice idioms for agents. Dep `effect 4.0.0-beta.59`. I did not confirm MCP mode |
| llms-effect | https://github.com/marbemac/llms-effect | — | 1 | 2026-01-21 | Curated collection of Effect repos for LLM-assisted learning |
| OXLint Effect rules | several, none official | — | ≤4 each | — | opsydyn/oxlint-effect (4 stars), mpsuesser/oxlint-plugin-effect, mpsuesser/effect-oxlint, cevr/effect-oxlint, EduSantosBrito/effect-rules, zaniluca/effect-rules, phibkro/oxlint-effect-plugin. tsgolint forks: tiara-stack/native-tooling, effect-app/tsgolint-fork |
| effect-patterns | https://github.com/PaulJPhilp/EffectPatterns | `effect-patterns-cli` | 802 | 2026-06-15 | Community patterns knowledge base |

- Other skills: joelhooks/effectts-skills (v4), betalyra/effect-skills, kitlangton/skills, mpsuesser/opencode-effect-enforcer, directormac/effect-v4-docs. Other tools: Effect-TS/vscode-extension (DevTools panel), `@effect/eslint-plugin`, deracs/create-effect-project (v4 scaffolder).

### Learning

- **effect.institute**: https://www.effect.institute, a tutorial series by Kit Langton. The source comes from awesome-effect's learning.md; I found no public repo.
- **visual-effect**: https://github.com/kitlangton/visual-effect (1160 stars, pushed 2026-07-06), interactive visualizations of Effect operators and programs, site effect.kitlangton.com. Kit also has an effect-atom visualizer at effect-atom.kitlangton.com. Related: topheman/effect-viz.
- **awesome-effect**: https://github.com/Marve10s/awesome-effect (84 stars, pushed 2026-09-15, owner Ibrahim Elkamali), split into v4 core, ecosystem and v3 legacy, and tags which packages are v4-ready. Its applications.md, learning.md and community.md are useful. An older list is evryg-org/awesome-effect-ts (66 stars).
- Also: effect.solutions, pigoz/effect-crashcourse (369 stars, 2024), PaulJPhilp/EffectPatterns.

### Apps (built with Effect)

- **dotheyplaytoday**: https://github.com/jackbisceglia/dotheyplaytoday (6 stars, 2026-09-13) emails you when your team (Celtics) plays today. Built with Effect and Solid.
- **shipwright**: https://github.com/piotr-m-jurek/shipwright (1 star, 2026-09-15) is an AI agent on Effect HttpApi that turns project inputs into a brief and an implementation PRD. Not the unrelated HarbourMasters or shipwright-io repos.
- **effect-isles**: https://github.com/xesrevinu/effect-event-log-isles (0 stars, 2026-08-21), "EventLog Isles", a creature-raising game that demonstrates Effect EventLog and Atom. Play at effect-isles.grok.me.
- **procdeck**: see TUI/CLI.
- Larger apps: anomalyco/opencode, pingdotgg/t3code, tim-smart/lalph, Effect-TS/slopcop (Cloudflare + Alchemy). Starters: brandhaug/b2b-saas-starter (CF, v4, Drizzle D1, Alchemy), NolanGC/foldkit-alchemy-starter, backpine/effect-worker-mono.

---

### UNVERIFIED / caveats
- **effect-tui (kitlangton)**: no such repo. The `effect-tui` npm package is unrelated and v3.
- **effect-react-query**: no distinct current package found. Probably the same thing as `effect-query` (voidhash) or tiesen243/effect-tanstack-query.
- **effect-solutions MCP mode**: the CLI is confirmed, MCP is not.
- **effect.institute**: the site is listed in awesome-effect, but I did not fetch it and found no repo.
- **humanlayer/fold, jbt95/effect-cf, effect-durable-streams-client, effect-devtui**: I did not check their `effect` version.
- The long tails under "Others" come straight from awesome-effect and were not checked one by one.


## Appendix: twie-101-118

## This Week in Effect #101-#118: Ecosystem Items

Source: https://effect.website/blog/this-week-in-effect/<N> (all 18 issues loaded).

### Issue dates
| # | Date | # | Date |
|---|---|---|---|
| 101 | 2026-01-16 | 110 | 2026-03-20 |
| 102 | 2026-01-23 | 111 | 2026-03-27 |
| 103 | 2026-01-30 | 112 | 2026-04-03 |
| 104 | 2026-02-06 | 113 | 2026-04-10 |
| 105 | 2026-02-13 | 114 | 2026-04-17 |
| 106 | 2026-02-20 | 115 | 2026-04-24 |
| 107 | 2026-02-27 | 116 | 2026-05-01 |
| 108 | 2026-03-06 | 117 | 2026-05-08 |
| 109 | 2026-03-13 | 118 | 2026-05-15 |

Format: **Name** - description - link - author - (issue)

---

### Community libraries

- **distilled-cloudflare** - Fully typed Cloudflare SDK for Effect generated from Cloudflare's OpenAPI spec (R2, KV, Workers, Queues, Workflows, DNS) - https://github.com/alchemy-run/distilled-cloudflare - Sam Goodwin / alchemy-run - (#101)
- **effer** - Effect-native UI library - https://github.com/lself1022/effer - lself1022 - (#101)
- **effect-playwright** - Wraps Playwright as Effect services/layers for browser automation and scraping - https://github.com/Jobflow-io/effect-playwright - Jobflow-io - (#101)
- **odata-effect** - Tree-shakable OData V2/V4 client for SAP services with type-safe query building and batch requests - https://github.com/joepjoosten/odata-effect - joepjoosten - (#102)
- **Foldkit** - Elm Architecture frontend framework built on Effect; launched docs site - https://foldkit.dev/ - Devin Jameson - (#103)
- **effect-inngest** - Effect SDK for Inngest durable workflows, Effect-native steps, Layer DI, Schema validation - https://github.com/erikshestopal/effect-inngest - erikshestopal - (#103)
- **effect-machine** - Schema-first type-safe state machines with compile-time transition validation, state-scoped effects, persistence/event sourcing - https://github.com/cevr/effect-machine - cevr - (#103)
- **voltaire-effect** - Effect + Voltaire Ethereum primitives for type-safe smart contract interactions, WASM crypto - https://voltaire-effect.tevm.sh/ - Tevm - (#103)
- **Drizzle ORM native Effect Schema support** - drizzle-orm@1.0.0-beta.15 ships native Effect Schema integration - https://x.com/DrizzleORM/status/2019529072897142935 - Drizzle team - (#104)
- **effect-redis** - Experimental Effect Redis wrapper with transactions, pipelines, all major command groups - https://github.com/envoy1084/effect-redis - envoy1084 - (#104)
- **ts-key-not-enum** - Type-safe comparison of KeyboardEvent .key non-printable values - https://github.com/nikelborm/effect-garden/tree/main/packages/ts-key-not-enum - nikelborm - (#104)
- **effortless-aws** - AWS serverless TS framework deriving infrastructure from code - https://github.com/kondaurovDev/effortless-aws - kondaurovDev - (#105)
- **effect-tg** - Library for building Telegram bots with Effect - https://github.com/grom-dev/effect-tg - grom-dev - (#105)
- **EffectCanvas** - Effectful Canvas renderer for React - https://github.com/Inalegwu/EffectCanvas - Inalegwu - (#105)
- **confect (v1)** - Deep Effect + Convex integration: Effect Schema DB schemas, validators, Convex as Effect services - https://github.com/rjdellecese/confect - rjdellecese - (#106)
- **effective-progress** - Effect-native CLI progress bar library - https://github.com/stromseng/effective-progress - stromseng - (#106)
- **effect-slack** - Type-safe Effect-native Slack SDK - https://github.com/MateoKruk/effect-slack - MateoKruk - (#107)
- **@effect-native/*@beta** - effect-native packages released with Effect v4 support - https://github.com/effect-native/effect-native/tree/v4 - effect-native - (#107)
- **effect-oauth-client** - OAuth 2.0 Client Credentials helper for Effect v4 HttpClient - https://github.com/successkrisz/effect-packages/tree/beta/packages/effect-oauth-client - successkrisz - (#108)
- **effect-htmx** - Effect-first integration for HTMX apps - https://github.com/tatemz/effect-htmx - Tate Barber - (#109)
- **effect-atom-jsx** - JSX-based reactive UIs with Effect atoms - https://github.com/doeixd/effect-atom-jsx - Patrick G. - (#109)
- **Foldkit UI** - 14 accessible, unstyled components for Foldkit - https://foldkit.dev/ui/overview - Devin Jameson - (#109)
- **Sentry Effect support** - Sentry JS SDK 10.44.0 adds Effect v3 support - https://github.com/getsentry/sentry-javascript/releases/tag/10.44.0 - Sentry (announced by Kit Langton) - (#110)
- **sveltekit-effect-runtime** - Runtime adapter wrapping SvelteKit handlers/loaders/actions with Effect - https://github.com/RATIU5/sveltekit-effect-runtime - RATIU5 - (#112)
- **lion** - JSON-based Lisp (all JSON is valid code), written 100% in Effect - https://github.com/andrueandersoncs/lion - andrueandersoncs - (#112)
- **effect-sql-model** - AST compiler turning Effect Schema / @effect/sql models into Drizzle ORM tables - https://github.com/emergente-labs/effect-sql-model - Emergente Labs (Francisco) - (#113)
- **effect-genserver** - GenServer-style actors for Effect; works with Cluster, RPC, Atom - https://github.com/tim-smart/effect-genserver - Tim Smart - (#114)
- **svelte-effect-runtime** - Effect runtime integration for Svelte - https://github.com/usebarekey/svelte-effect-runtime - usebarekey - (#114)
- **effect-encore** - Build Encore.ts applications with Effect - https://github.com/cevr/effect-encore - cevr - (#114)
- **effect-prodigi** - Type-safe Effect bindings for Prodigi print-on-demand API - https://github.com/mpsuesser/effect-prodigi - Marc Suesser - (#114)
- **effql** - sqlc-style codegen for Effect SQL via Postgres introspection - https://github.com/gloomweaver/effql - gloomweaver - (#115)
- **id_effect** - Rust library for composable effect types (success/error/env) - https://industrial.github.io/id_effect/ - industrial - (#115)
- **posthog-effect** - Effect-native PostHog analytics/feature-flag SDK - https://github.com/EduSantosBrito/posthog-effect - EduSantosBrito - (#115)
- **Drizzle native Effect v4 support** - Drizzle ORM supports Effect v4 natively - https://x.com/DrizzleORM/status/2049984887147331889 - Drizzle team - (#116)
- **@rivetkit/effect** - Effect SDK for Rivet Actors (typed errors, validation, resource safety) - https://github.com/rivet-dev/rivet/pull/4703 - Rivet - (#116)
- **effect-boxes** - Flex-style layout system for terminal apps - https://github.com/lloydrichards/effect-boxes - lloydrichards - (#116, #117)
- **sqlfu @effect/sql support** - sqlfu adding effect/sql support (announced) - https://x.com/mmkalmmkal/status/2051620858888589344 - Misha Kaletsky - (#117)
- **@nmnmcc/ability** - Authorization/permission-checking library in Effect style - https://github.com/nmnmcc/ability - nmnmcc - (#117)
- **@siebix/cloudflare-browser-run-effect** - Effect service with typed schemas for Cloudflare Browser Run Quick Actions - https://github.com/siebix-studio/effect-reusables/tree/main/packages/cloudflare-browser-run-effect - siebix-studio - (#117)
- **zenbu.js** - Framework for apps users/agents can modify at runtime via source edits or plugins - https://github.com/zenbu-labs/zenbu.js - zenbu-labs - (#118)
- **effect-qb** - Effect query builder (featured video) - https://youtube.com/watch?v=DBNYChnOqcA - (#118)

### Tools / DX

- **Effect LSP** - Effect language service/devtools (community shout-out) - https://effect.website/docs/getting-started/devtools/#effect-lsp - Effect team - (#108)
- **effect-viz** - Browser runtime visualizer (fiber tree, timeline, execution log); v2.0.0 in #108 - https://github.com/topheman/effect-viz (demo https://effect-viz.vercel.app) - Christophe Rosset (topheman) - (#105, #108)
- **bsky-cli** - Agent-first Bluesky data filtering/monitoring CLI - https://github.com/mepuka/bsky-cli - mepuka - (#105)
- **zed-effect-tsgo** - Zed extension integrating @effect/tsgo (Go TS compiler + Effect diagnostics) - https://github.com/RATIU5/zed-effect-tsgo - RATIU5 - (#110)
- **effect-jetbrains-plugin** - JetBrains plugin for @effect/tsgo LSP and Effect runtime devtools - https://github.com/kriegcloud/effect-jetbrains-plugin - elpresidank - (#111)
- **effect-analyzer** - Browser static analysis for Effect code: railway diagrams, service deps, error flows, complexity - https://jagreehal.github.io/effect-analyzer/ - Jag Reehal - (#111, #112)
- **effect-oxlint** - Write oxlint custom rules using Effect v4 patterns - https://github.com/mpsuesser/effect-oxlint - mpsuesser - (#112)
- **spana** - TS-native E2E testing across React Native (Android/iOS) and web from one suite - https://github.com/wezter96/spana - wezter96 - (#113)
- **@catenarycloud/linteffect** - Biome Grit rules for Effect composition style - https://www.npmjs.com/package/@catenarycloud/linteffect - Roman Naumenko - (#113)
- **kbroom-nvim** - Neovim config with Effect-inspired Lua LS setup - https://github.com/ggallovalle/kbroom-nvim/blob/nvim-0.12/lua/my/luarcjson.lua - ggallovalle - (#114)
- **effect-error-pretty.nvim** - Neovim plugin making Effect<A,E,R> assignability errors readable - https://github.com/rashedInt32/effect-error-pretty.nvim - rashedInt32 - (#115)
- **otel-tui + Effect OpenTelemetry** - Local trace visualization without Datadog/Docker (tip) - https://x.com/janbhwilhelm/status/2046571748984856630 - Jan Wilhelm - (#115)
- **Lensflare** - Open-source macOS dev observability stack for humans and AI agents - https://lensflare.dev - Dominik Vit - (#116)
- **@wolfcola/treeshake-check** - Tree-shakeability analyzer built on Effect + @effect/cli - https://www.npmjs.com/package/@wolfcola/treeshake-check - wolfcola - (#118)
- **effect-http-starter** - Scaffolder for Effect HTTP servers (schema-first, CRUD, health, Scalar docs, OpenAPI) - https://github.com/rxssula/effect-http-starter/ - rxssula - (#118)
- **maple** - OpenTelemetry observability platform - https://github.com/Makisuo/maple - Makisuo - (#107)
- **Dtapline** - Deployment tracking/visualization platform built with Effect - https://dtapline.com/ - Victor Korzunin - (#107)

### AI / agent tooling

- **Effect Best Practices (skill)** - AI coding-assistant skill enforcing Effect patterns (services, errors, atoms, config, o11y) - https://skills.sh/makisuo/skills/effect-best-practices - makisuo - (#103)
- **Lalph** - Ralph-inspired AI agent orchestrator powered by Effect (Linear, git worktrees, PR review); livestream series - https://youtube.com/watch?v=wYddFSTHo5E - Tim Smart - (#101-#105)
- **effect-gpt** - Transformer LLM from scratch in Effect (tokenization, training, inference) - https://github.com/erayack/effect-gpt - erayack - (#104)
- **jazz** - CLI for creating autonomous AI agents, built with Effect - https://github.com/lvndry/jazz - lvndry - (#106)
- **agentpane** - Web interface for AI coding agents - https://github.com/bgub/agentpane - Ben Gubler - (#107)
- **Effect AI on Golem** - Video on running Effect AI on Golem - https://www.youtube.com/watch?v=xX4rccXwIJM - (#107)
- **cuttlekit** - Generative UI toolkit: LLM-generated interactive UIs with streaming, sandboxing, multi-model - https://github.com/betalyra/cuttlekit - Betalyra - (#108)
- **Effect coding-agent toolkit (teaser; later "Clanka")** - Toolkit for building custom coding agents - https://x.com/tim_smart/status/2032235002675806536 - Tim Smart - (#109; Clanka videos #115, #116)
- **effect.solutions** - Guide recommending cloning/subtreeing the Effect repo for agents - http://effect.solutions - Michael Arnaldi (referenced) - (#110, #111)
- **expect** - Lets agents (Claude Code/Codex) QA your app in a real browser; mostly written in Effect - https://github.com/millionco/expect - Million Software (Aiden Bai) - (#111, #112)
- **audius-mcp-atris** - Code Mode MCP server using Effect for Audius - https://github.com/glassBead-tc/audius-mcp-atris - glassBead - (#111)
- **effect-skills** - Opinionated Effect best-practice guidelines for agents - https://github.com/betalyra/effect-skills - Betalyra - (#112)
- **opencode-effect-enforcer** - OpenCode plugin enforcing Effect v4 guardrails in real time - https://github.com/mpsuesser/opencode-effect-enforcer - mpsuesser - (#112)
- **github-stars-organizer** - One-prompt project with Opus 4.6 + Effect MCP - https://github.com/davidnussio/github-stars-organizer - David Nussio - (#112)
- **effect-autoagent** - Build/optimize/deploy AI agents as Effect services - https://github.com/mpsuesser/effect-autoagent - Marc Suesser - (#113)
- **effect-claudecode** - Write Claude Code plugins with Effect v4 - https://github.com/mpsuesser/effect-claudecode - Marc Suesser - (#113)
- **Foldkit DevTools MCP** - MCP server for Foldkit devtools - https://foldkit.dev/ai/mcp - Devin Jameson - (#116)
- **pi-effect-harness** - Pi extension enforcing Effect v4 best practices during agent coding - https://github.com/mpsuesser/pi-effect-harness - mpsuesser - (#117)
- **effect-uai** - Effectful building blocks for agentic AI - https://effect-uai.betalyra.com - Betalyra - (#117)
- **Fiberplane self-driving codebase** - Claude Code + Effect traces/ast-grep/drift as agent guardrails (stream + posts) - https://x.com/fiberplane/status/2051673252292911391 - Fiberplane - (#111, #112, #114, #117)
- **"The one weird Git trick that makes coding agents more Effect-ive"** - Official blog: vendor Effect source via git subtree for agents - https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive/ - Maxwell Brown - (#118)

### Official releases & features

- **Effect 3.19 / @effect/ai 0.27.0 / @effect/workflow (alpha)** - Ongoing "recent major updates" - https://effect.website/blog/releases/effect/319 - (#101-#105)
- **@effect/opentelemetry protobuf OTLP** - Protobuf protocol support for OTLP exporters (PR 5927) - https://github.com/Effect-TS/effect/pull/5927 - (#102)
- **Platform Terminal rows/isTTY** - https://github.com/Effect-TS/effect/pull/5977 - (#102)
- **@effect/sql-sqlite-bun SafeIntegers; better-sqlite3 v12** - https://github.com/Effect-TS/effect/pull/6016 - (#104)
- **AGENTS.md added to Effect repo** - https://github.com/Effect-TS/effect/pull/6028 - (#104)
- **Effect v4 Beta** - Rewritten runtime, ~70kB -> ~20kB minimal bundle, unified versioning, packages merged into core - https://effect.website/blog/releases/effect/40-beta/ - Effect team - (#106)
- **v4: Tx modules / transaction model refactor; Schema Option helpers** - https://github.com/Effect-TS/effect-smol/pull/1515 - (#107)
- **v4: static file server, expireCookie, HttpClient.withRateLimiter retry-after, Atom.swr, Command.withSharedFlags** - (#108)
- **v4: effect/cli/Completions (shell autocompletion), toolkit unions, Layer.mock dual** - (#109)
- **Effect 3.20 security update (GHSA-38f7-945m-qr2g) and Effect 3.21.0** - https://effect.website/blog/effect-3-20-security-update/ - (#110)
- **v4: Embeddings module + ModelDimensions, Anthropic dynamic tools, Schema.ArrayEnsure, Url port, HttpApiMiddleware.layerSchemaErrorTransform** - (#110)
- **v4: HttpApi codegen (HttpApi.gen), HttpApiClient rework, Stream.timeoutOrElse, dedicated PG LISTEN connection** - (#111)
- **v4: Schema overhaul (make, Schema.asClass), IndexedDb module merged, KeyValueStore.layerSql, Layer.suspend** - (#112)
- **v4: ServiceMap renamed back to Context (breaking); IDB streaming/rebuild; StringFromBase64/Hex/UriComponent; rpc ConnectionHooks** - (#113)
- **v4: RPC deferred responses, RpcGroup.omit, IDB persistence layer, Schema.annotateEncoded** - (#114)
- **v4: new @effect/sql-pglite, Effect.abortSignal, Socket.make, Effectable module; workflow/DurableDeferred fixes** - (#115)
- **v4: AsyncResult .exhaustive(), OpenAI reasoning support** - (#116)
- **v4: HttpApiTest module, Effect.acquireDisposable (TC39 `using`), Effect.firstSuccessOf, Schema.DurationFromString, Config.literals, Rpc.custom** - (#117)
- **v4: DurableQueue ported, Sql.unique, service-requiring schema defaults, Effect.Yieldable removed** - (#118)
- **Milestones** - Effect crossed 10M weekly npm downloads (#114); 14k GitHub stars (#116)

### Learning resources

#### Blog posts / articles
- **Effect TS: The New Standard for Building Production APIs** - https://blog.type-driven.com/effect-ts-new-standard/ - Type Driven - (#102)
- **Building a Fault-Tolerant Web Data Ingestion Pipeline with Effect-TS** - https://javascript.plainenglish.io/building-a-fault-tolerant-web-data-ingestion-pipeline-with-effect-ts-0bc5494282ba - (#102)
- **Effect and the Near Inexpressible Majesty of Layers** - Layers & DI - https://x.com/kitlangton/article/2016945444312498340 - Kit Langton - (#104)
- **TestClock tip** - time-based testing - https://effect.website/docs/testing/testclock/ - Samuel Huber - (#111)

#### Courses / guides / pattern collections
- **EffectPatterns** - +81 patterns (75 Schema) - https://github.com/PaulJPhilp/EffectPatterns - Paul Philp - (#105)
- **EffectTalk** - Production-ready Effect patterns - https://effecttalk.dev/ - Paul Philip - (#106)
- **Effective Software courses** - Free courses: Effect Atom, HttpClient (#106), Schema v4 (#108, #111), Foundation/Services & Layers (#112), HTTP API (#114), Configuration (#115) - https://www.effective.software/courses - Hemanta Kumar Sundaray
- **real-world-effect** - Collection of open-source Effect apps - https://github.com/jeremyosih/real-world-effect - jeremyosih - (#109)
- **Effect Institute** - Learning site praised by community - https://www.effect.institute/ - (#114)
- **Effect for TypeScript Developers** - 33-step learning guide - https://tonytangdev.github.io/effect-for-ts-developers/ - tonytangdev - (#114)
- **Large OSS Effect codebases** - AnswerOverflow (v3), rhyssullivan/executor (v4) - https://github.com/rhyssullivan/executor - Rhys Sullivan - (#117)
- **Foldkit vs React side-by-side** - Same pixel art editor in both - https://foldkit.dev/foldkit-vs-react-side-by-side - Devin Jameson - (#112)

#### Videos / talks
- **Effect in 5(ish): Cache** (#101) https://youtube.com/watch?v=e0qYYn4deWs, **RcMap** (#102) https://youtube.com/watch?v=JGcZTqjDZPk, **Actor Model / Cluster** (#103) https://youtube.com/watch?v=Pp9ufBrtNgE - Lucas Barake
- **I wish I learned Effect sooner** - https://youtube.com/watch?v=85yz418Tris - backpine labs - (#102)
- **Refactoring Twitch-Spotify Integration with Effect Cluster** - https://youtube.com/watch?v=cLxqMczCDeU - (#103)
- **Effect Office Hours 11-28** - Weekly official streams (topics: v4, Services & Layers, STM, Language Service/tsgo, Alchemy, typed errors vs defects) - https://www.youtube.com/@effect-ts - (#101-#118)
- **Effect: Production-Grade TypeScript (CityJS London 2025)** - https://youtube.com/watch?v=apklpPEgZgw - Michael Arnaldi - (#106)
- **v4 Beta video series** - 3x faster runtime (j7U4QuueGE0), Schema v4 (Ej8MBEmUTNI), Migrating v3->v4 (eHVmHyo7ut0), Unstable Modules, Accessors removed, Effect.Service removed/References, Yieldable, Logger, CLI v4, Schedule/Layer/Channel, Filter/Result, HttpApi v4 - youtube.com/@effect-ts - (#107-#111)
- **Why My Coding Agents Use Effect** - https://youtu.be/s6uAUvAaRN0 - Parker Landon - (#107)
- **Matt Pocock on Effect** - https://www.youtube.com/watch?v=uC44zFz7JSM&t=440s ; https://www.youtube.com/watch?v=S2GChOwivwQ ; talk https://youtube.com/watch?v=v4F1gFy-hqg - (#107, #116)
- **My Favorite TypeScript Library Just Got So Much Better** - https://youtube.com/watch?v=C2bc_Lcth6E - Ben Davis - (#108)
- **Effect Schema v4, Effectful Schemas** - https://youtube.com/watch?v=wFNbDkE69_U - (#109)
- **Tagged Errors / TaggedErrorClass vs Data TaggedError / ExecutionPlan** - (#110)
- **How to use AI Agents with Effect the right way** https://youtube.com/watch?v=XaNHyZbFUBY ; **LLM usage tips from the Effect Team** https://youtube.com/watch?v=T8wa7rtIVk8 - (#111)
- **Mike's workflow for coding with agents** https://youtube.com/watch?v=LHAmzj3tRfQ ; **Tips on convincing co-workers** https://youtube.com/watch?v=ai4BPExx4AY - (#112)
- **TypeScript-Go with Effect LSP setup guide** - https://youtube.com/watch?v=mUlhau663eM - (#113)
- **Intro to STM** https://youtube.com/watch?v=JG8JRClKGG8 ; **Roasting Tim's OpenCode PR** https://youtube.com/watch?v=PxQheh_YO-c - (#114, #115)
- **Building an AI coding framework with Effect - Clanka #1** https://youtube.com/watch?v=bALynmav8D8 (#115); **Clanka: token metrics & search** https://youtube.com/watch?v=4zFLhYoCAW8 (#116)
- **Alchemy, Infrastructure as Effects (Office Hours 27)** - Alchemy v2 by Sam Goodwin - https://youtube.com/watch?v=fPSxB7ZgSJw - (#116, #117)
- **Vibe Engineering Effect Apps (AI Engineer Europe)** - https://youtube.com/watch?v=Wmp2Tku2PrI - Michael Arnaldi - (#113, #117)
- **DrainableWorker** https://youtube.com/watch?v=41bNtyz4NZE ; **Roasting T3 Code** https://youtube.com/watch?v=gMWpWQ6XooA - (#117)
- **Effect Workflows & Cluster** - https://youtube.com/watch?v=2clmlNPGqTE - (#118)
- **Cause & Effect podcast: Warp (payroll with Effect)** - https://youtube.com/watch?v=zxCR6rG4snY - Adam Rankin w/ Johannes Schickling - (#103)

### Example apps / products built with Effect

- **StudioCMS v0.1.0** - Astro CMS with API/SDK rebuilt on Effect - https://studiocms.dev/blog/v0-1-release - (#101)
- **ChEffect** - Local-first meal planning app (Effect + LiveStore) stream series - https://youtube.com/watch?v=F8qp6XrUYtA - Maxwell Brown & Tim Smart - (#101, #110, #111)
- **better-pdf-reader** - Local-first PDF/EPUB reader with command palette, AI Markdown export - https://github.com/BLANKSPACETS/better-pdf-reader - BLANKSPACETS - (#102)
- **serial.dev** - Multiplayer coding platform with sandboxes (Effect backend) - https://serial.dev/ - (#103)
- **Polar CLI** - Polar using Effect in production - https://polar.sh/ - Emil Widlund - (#104)
- **effect-url-shortener** - URL shortener API demo - https://github.com/bishalr0y/effect-url-shortener - bishalr0y - (#104)
- **AnswerOverflow** - Fully Effect, 1.5M MAU - https://github.com/AnswerOverflow/AnswerOverflow - Rhys Sullivan - (#108)
- **OpenCode** - Adopting Effect; migrated Hono -> Effect HttpApi (v1.14.42) - https://github.com/sst/opencode - Kit Langton / Dillon Mulroy - (#108, #112, #118)
- **T3 Code** - Built nearly entirely with Effect v4 - https://github.com/pingdotgg/t3code - pingdotgg (Julius) - (#109, #110)
- **Hazel** - Migrated to v4: -8k LOC, -500kb bundle - https://x.com/makisuo/status/2033522625855586594 - Makisuo - (#110)
- **blikka** - Open-source SaaS for photo marathons - https://github.com/strandhvilliam/blikka - Villiam Strandh - (#110)
- **Supermemory** - Composable Effect architecture - https://supermemory.ai/ - Dhravya Shah - (#111)
- **tanstack-cloudflare-effect-shopify-app** - Shopify template on TanStack Start + Workers + Effect v4 - https://github.com/mw10013/tanstack-cloudflare-effect-shopify-app - mw10013 - (#116)
- **s20-wifi-setup** - CLI to connect Orvibo S20 sockets to Wi-Fi - https://github.com/kachkaev/s20-wifi-setup - kachkaev - (#117)
- **introw** - First Effect service, ~95% AI-written - https://www.introw.io/ - Pruxis - (#118)


## Appendix: twie-119-latest

## This Week in Effect #119 – #135: Ecosystem Items

Source: https://effect.website/blog/this-week-in-effect/<N>/ (#136+ return 404 as of 2026-09-16).
Dates are the publish date from each page's `datetime` attribute.

| Issue | Date | Headline |
|---|---|---|
| 119 | 2026-04-23 (covers mid-May content) | v4 beta docs overhaul, Stream.broadcastN, Crypto service |
| 120 | 2026-05-28 | HttpApiSecurity.http, v4 beta launch-to-May recap |
| 121 | 2026-06-01 | OTLP env-var layer, Schema fixes |
| 122 | 2026-06-11 | Tree-shaking, Entity reliability fix |
| 123 | 2026-06-18 | HttpApi streaming responses; Podcast #8 (Kit Langton / OpenCode) |
| 124 | 2026-06-19 | RateLimiter.adaptive, SQL.valuesUnprepared |
| 125 | 2026-06-26 | Url.make, HttpApi fixes |
| 126 | 2026-07-07 | Schedule overhaul, LayerRef, node:sqlite, FileSystem glob |
| 127 | 2026-07-16 | effect-smol merged into Effect-TS/effect (main = v4) |
| 128 | 2026-07-24 | Cron hardening, Effect.reduce, new website; Podcast #9 (Foldkit) |
| 129 | 2026-07-28 | Native Deno platform, security hardening, Ziverge adoption partner |
| 130 | 2026-08-05 | OXLint rules, API reference docs; Podcast #10 (John De Goes) |
| 131 | 2026-08-12 | **Effect v4 Release Candidate**, Effect Days 2026 announced |
| 132 | 2026-08-15 | Match.fn, RPC stream backpressure, MCP spec adapter |
| 133 | 2026-08-26 | Zero-dependency core, native PgProtocol client, pull-based Sockets |
| 134 | 2026-08-31 | Perf pass, native TLS sockets, Astra 200-PR sweep |
| 135 | 2026-09-07 | Schema.transformOrFail -> transformEffect rename |

---

### Community libraries

| Name | Description | Link | Author | Issue |
|---|---|---|---|---|
| effect-cf | Effect-native primitives for Cloudflare Workers & Durable Objects (services as contexts/layers) | https://github.com/danieljvdm/effect-cf | Daniel van der Merwe (@danieljvdm) | 119 |
| effect-boxes v0.15.0 | Adds Layout module (Flex, Container, Grid) on top of Box primitive | https://github.com/lloydrichards/effect-boxes/releases/tag/v0.15.0 | Lloyd Richards | 119 |
| effect-hatchet | Effect-native bindings for Hatchet with in-memory test implementation | https://github.com/fdarian/effect-hatchet | fdarian | 119 |
| Cortex | Effect-native ORM for vector databases | https://cortex-vector.vercel.app/ | - | 119 |
| Foldkit | Effect-native, Elm-inspired frontend framework (SSR landed in #132) | https://foldkit.dev/ | Devin Jameson | 119, 120, 128, 132 |
| effect-boxes / TUI Components | TUI components and select prompt tutorial | https://effect-boxes.lloydrichards.dev/tutorials/select-prompt , https://www.lloydrichards.dev/labs/061-tui-components | Lloyd Richards | 120 |
| livetrace | Real-time Effect span streaming to frontend (React) UIs | https://github.com/necmttn/livetrace | necmttn | 120 |
| Veya | Programmable video creation library for TypeScript | https://github.com/nmnmcc/Veya | nmnmcc | 120 |
| Rivet Effect SDK | First-class Effect support / Effect SDK for Rivet Actors (durable state, realtime, tracing) | https://rivet.dev/ | Rivet (Nathan Flurry) | 121, 123, 124, 126 |
| Verrex | Effect-native UI framework where A/E/R channels flow up the view tree (JSX + fine-grained reactivity) | https://m9tdev.github.io/verrex/ | Mathieu (@m9tdev) | 122 |
| effect-bdd | Effect-native runner for Gherkin .feature files | https://github.com/tatemz/effect-bdd | tatemz | 122 |
| redfx | Typed Redis client for Effect: schema-validated keys, pub/sub streams, distributed caching | https://github.com/al3xanderwalker/redfx | al3xanderwalker | 123 |
| evm-effect | Ethereum Virtual Machine implementation in TS on Effect, focused on debuggability | https://github.com/julia-script/evm-effect | julia-script | 123 |
| effract | Write React components as Effect programs; runs across SPA, server, Workers, RSC | https://github.com/get-tmonier/effract | Tmonier | 124 |
| effect-typed-id | Effect implementation of the TypeID spec | https://github.com/just-be-dev/effect-typed-id | Justin Bennett | 125 |
| unitflow | Effect-first state manager | https://github.com/timurrakhimzhan/unitflow | Timur Rakhimzhan | 126 |
| Crosshatch | Effect-native toolkit for x402 accountless payments (EVM & Solana stablecoins) | https://github.com/crosshatch/crosshatch (https://crosshatch.dev) | Harry Solovay | 127 |
| svelte-effect-runtime | Vite plugin + language server for effectful code in Svelte component scripts (v4 release) | https://github.com/usebarekey/svelte-effect-runtime | usebarekey | 127 |
| effect-atom | Reactive state/atoms for Effect (recommended for FE work) | https://github.com/tim-smart/effect-atom | Tim Smart | 129 |
| conform-to-effect | Conform form helpers using Effect Schema validation | https://github.com/carloitaben/conform-to-effect | carloitaben | 129 |
| effect-torch | Experimental learning-oriented tensor library on Effect with Rust (candle) backend | https://github.com/mikearnaldi/effect-torch | Mike Arnaldi | 129 |
| effect-libs-browser | Effect-native browser automation for Workers/edge (Playwright, Stagehand, CDP) | https://github.com/LordCoughmann/effect-libs-browser | LordCoughmann | 129 |
| effect-units | Typed quantities & dimensionally-checked unit conversions | https://github.com/rjdellecese/effect-units | rjdellecese | 129 |
| effect-machine | Schema-first state machines/statecharts; incubator for proposed Machine API | https://github.com/typeonce-dev/effect-machine | typeonce-dev (Sandro Maglione) | 128, 129 |
| Foldocs | Framework for documentation websites with Foldkit + Effect | https://github.com/tarkaworks/foldocs | TarkaWorks | 130 |
| effect-domain | Domain action graph: define resources/actions/schemas once, serve via REST/RPC/GraphQL/sync | https://github.com/mac-monet/effect-domain | mac-monet | 131 |
| effect-mq | Background jobs for Effect (BullMQ alternative; complements Cluster) | https://github.com/TeamWarp/effect-mq (effect-mq.com) | Adam Rankin (Warp) | 133, 135 |
| effect-temporal | Author durable workflows with Effect schemas/errors, run on Temporal | https://github.com/TeamSpringbird/effect-temporal | Springbird | 133 |
| xstate/effect (teased) | Upcoming XState integration with Effect | - | Stately / David Khourshid | 133 |
| tea-effect | The Elm Architecture for TS with Effect (elm-ts successor) + React hooks | https://github.com/savkelita/tea-effect | Marko Savic | 134 |
| herdr-ts-sdk | TypeScript SDK (Effect) for herdr, announced as near release | - | Dillon Mulroy | 134 |
| effect-lsc | Effect Live Server Components: Phoenix LiveView-style backend-first UI framework | https://github.com/pigoz/effect-lsc | Stefano Pigozzi | 135 |
| ilha | Lightweight isomorphic UI library: server-rendered reactive components with partial hydration | https://github.com/ilhajs/ilha | ilhajs | 135 |
| Craft | TS UI framework (components, reactivity, routing) integrating with Effect | https://craft-ts.github.io/craft/ | craft-ts | 135 |
| Golem Cloud Effect SDK | Effect SDK for Golem Cloud produced by Ziverge | https://golem.cloud/ | Ziverge | 129 |
| Sentry Effect support | Sentry observability support for Effect v3 and v4 | https://sentry.io/ | Sentry | 134 |

### Tools / DX

| Name | Description | Link | Author | Issue |
|---|---|---|---|---|
| sqlc-gen-better-typescript | sqlc WASM plugin generating type-safe TS from SQL (Effect v4 or plain async) | https://github.com/eikster-dk/sqlc-gen-better-typescript | eikster-dk | 121 |
| effect-language-service-tsgo (Zed) | Effect Language Service extension installable in Zed | https://zed.dev/extensions/effect-language-service-tsgo | Effect-TS | 121 |
| Maple Local Mode | Maple as single local binary: OTLP ingest, embedded ClickHouse, query API, dashboard | https://maple.dev/docs/local-mode/ | Maple | 121, 131 |
| effect-workflow-viz | Remix 3 + Effect dashboard to visualize @effect/workflow runs | https://github.com/Mufraggi/effect-workflow-viz | Mufraggi | 122 |
| nx (rockware-ai) | Nx plugins: @rockware-ai/nx-effect generators (libs/services/apps, @effect/vitest) and nx-varlock env validation | https://github.com/rockware-ai/nx | rockware-ai | 125 |
| Effect LSP rules for OXLint | Effect LSP diagnostics as custom type-aware OXLint rules; vite-plus support | https://github.com/Effect-TS/tsgo#lsp-based-linter | Mattia Manzati / Effect-TS | 130 |
| effect/tsgo (replaces legacy LSP) | Legacy LSP removed in favor of effect/tsgo | https://github.com/Effect-TS/tsgo | Effect-TS | 127 |
| repo-dive | Explore git repo history: per-commit snapshots, metrics catalog, dashboard, MCP support | https://github.com/kachkaev/repo-dive | Alexey Kachkaev | 131 |
| procdeck | Run whole dev stack with one command; processes as browser terminal panes, port assignment, traffic view | https://github.com/kondaurovDev/procdeck | Aleksandr Kondaurov | 133 |
| create-effect-project | npx scaffolder for Effect v4 projects (HttpApi, full-stack, CLI, AI agent, CF Worker; Node/Bun) | https://github.com/deracs/create-effect-project | Michael Goldsmith | 134 |
| effect-ast-grep-rules | Reusable ast-grep rules for Effect TS projects | https://github.com/danielo515/effect-ast-grep-rules | Daniel Rodriguez Rivero | 134 |
| okf-graph | Effect CLI to explore/validate Open Knowledge Format bundles as a graph | https://github.com/lloydrichards/proj_okf-graph | Lloyd Richards | 134 |
| Experimental Schema compiler | Opt-in compiler for Effect Schema (PR) | https://github.com/Effect-TS/effect/pull/7908 | Giulio Canti | 134 |
| cbranch | Cross-platform browser-based Git GUI | https://github.com/cbnsndwch/cbranch | cbnsndwch | 129 |
| muster | Keyboard-driven TUI for managing GitHub issues across repos | https://github.com/mrtdurdenthe2/muster | mrtdurdenthe2 | 128 |
| git (chr33s) | Unified Git impl: Smart-HTTP server, browser client, CLI; agent-native signed reviews; Effect v4 (foldkit branch) | https://github.com/chr33s/git | chr33s | 135 |
| Alchemy | Effect-based infrastructure-as-code (Cloudflare-first, SST/Terraform alternative) | https://v2.alchemy.run/ | alchemy_run (Sam Goodwin) | 119, 121, 126, 134 |

### AI / agent tooling

| Name | Description | Link | Author | Issue |
|---|---|---|---|---|
| effect-agents | Examples of building agents with Effect (typed retries, HITL, MCP from toolkit) | https://effect-agents.coey.dev/ | Jordan Coeyman (@acoyfellow) | 120 |
| ax | Effect-powered local-first observability/memory layer for coding agents (Claude Code, Codex) | https://ax.necmttn.com/ | necmttn | 122 |
| Slashspace AI | Canvas-first desktop app with multi-agent spaces; Effect backend | https://www.producthunt.com/products/slashspace-ai | - | 122 |
| tokenmaxxing | Public leaderboard of LLM coding agent usage/costs; built with Effect v4 | https://tokenmaxxing.sh/ | 851 Labs | 124 |
| Cycle | Local-first AI-agent-driven ticket system backed by git | https://github.com/robertpitt/cycle | Robert Pitt | 126 |
| citymcp | Gives agents live city data (MCP) | https://citymcp.com/ | Sean Lees | 126 |
| Kit Langton skills | Agent skills incl. writing production TS with Effect v4 | https://github.com/kitlangton/skills | Kit Langton | 127 |
| effect.solutions | Effect guidance site for agents/humans | https://www.effect.solutions/ | Kit Langton | 128, 130 |
| effect-v3-to-v4 skill (official) | Agent skill to migrate Effect v3 projects to v4 | https://www.skills.sh/effect-ts/skills/effect-v3-to-v4 | Effect-TS | 131 |
| shipwright | Effect HttpApi agent turning messy inputs into Project Brief + agent-ready PRD | https://github.com/piotr-m-jurek/shipwright | Piotr Malecki-Jurek | 133 |
| effect-agent | Agent framework: schema-defined agents, typed failures, subagents, codemode, durable on Cloudflare | https://github.com/danieljvdm/effect-agent (https://effect-agent.com/) | Dan van der Merwe | 134 |
| Tardigrade | Agent harness framework: typed state-machine components over immutable event log | https://tardigrade.sh/docs/why | - | 134 |
| fidy-ai | Agent-first personal finance product (Colombia) via WhatsApp, on Effect | https://github.com/B4rz99/fidy-ai | Orlando Barboza | 134 |
| effect-uai | Composable effectful building blocks for AI agents | https://github.com/betalyra/effect-uai | betalyra | 135 |
| Astra on Effect | OpenAI/anomalyco Astra agent run on Effect repo: 204 PRs in ~2 days | https://effect.website/blog/astra-vs-the-boys | Kit Langton / anomalyco | 134, 135 |
| OpenCode | AI coding agent migrated to Effect | https://opencode.ai/ | Dax Raad / Kit Langton | 119, 121, 123 |

### Official releases & features

| Item | Description | Link | Issue |
|---|---|---|---|
| v4 beta: docs overhaul + standard-jsdoc lint | Standardized JSDoc, new ESLint rule | https://github.com/Effect-TS/effect | 119 |
| Stream.broadcastN, Schedule.tap, Command.withHidden | New stream/CLI primitives | - | 119 |
| Crypto service (@effect/platform) | Cross-platform cryptography API | - | 119 |
| Model.Generated -> Model.GeneratedByDb; Schema.asserts change | API refinements | - | 119 |
| SQL .mts/.mjs migrations; ShardingConfig.availableShardGroups | SQL & sharding | - | 119 |
| HttpApiSecurity.http | Custom HTTP auth schemes + OpenAPI output | - | 120 |
| Effect v4 beta launch-to-May recap | Topic-organized recap blog | https://effect.website/blog/effect-v4beta-launch-to-may-recap/ | 120 |
| OTLP env-var layer; GUID/max UUID schema filters; Workflow.make aligned with Rpc | Observability & schema | - | 121 |
| Tree-shakable module side effects; Claude 4 native structured output in ai-anthropic | - | - | 122 |
| HttpApi streaming responses (SSE/chunked) | Long-requested feature | - | 123 |
| Effect.transposeOption, Random.choice ported; RpcGroup.toHandlers definition-first; OpenRouter audio input | - | - | 123 |
| RateLimiter.adaptive | Adaptive rate limiter strategy | - | 124 |
| Effect.fromOption custom errors; SQL.valuesUnprepared; Latch.isOpen; MssqlClientConfig options | - | - | 124 |
| UrlParams.makeUrl -> Url.make | URL API refinement | - | 125 |
| Schedule overhaul (Schedule.min/max, vixie cron semantics) | - | - | 126 |
| Schema.Decoder / Schema.Encoder types, Schema.DateFromMillis | - | - | 126 |
| LayerRef module | Swappable Layer reference at runtime | - | 126 |
| sql-sqlite-node uses node:sqlite (drops better-sqlite3) | - | - | 126 |
| FileSystem glob support; RPC IDs string|number | - | - | 126 |
| effect-smol archived; Effect-TS/effect main = v4 (v3 on v3 branch) | Repository milestone | https://github.com/Effect-TS/effect | 127 |
| Graph set operators; CLI wizard mode reintroduced | - | - | 127 |
| Effect.reduce; Schema.toTaggedUnion discriminants; sql-mysql2 disablePreparedStatements | - | - | 128 |
| Redesigned Effect website (public repo) | New site | https://github.com/Effect-TS/website | 128 |
| @effect/platform-deno native Deno support | HTTP, sockets, cluster, multipart | - | 129 |
| v3->v4 API diff migration tooling; security hardening sweep; atom custom equality | - | - | 129 |
| Command.env extendEnv; Doc.sanitize (printer) | v3 features | https://github.com/Effect-TS/effect/pull/6652 , https://github.com/Effect-TS/effect/pull/6775 | 129 |
| Ziverge as first Effect Adoption Partner + Effect Training Workshop | - | https://www.effect.website/adoption-partners/ziverge | 129 |
| API reference docs (v3 & v4) on website | Improved search | https://effect.website/docs/v4/api | 130 |
| D1 batch support; HttpClient tracer header filter; MCP conformance test suite | - | - | 130 |
| **Effect v4 Release Candidate** | API presumed stable | https://www.effect.website/blog/releases/effect/40-rc | 131 |
| NodeRedis migrated ioredis -> redis | - | - | 131 |
| Effect jobs page | Official jobs listing | https://www.effect.website/effect-jobs | 131 |
| Match.fn selectors, dual Optic functions, RPC HTTP stream backpressure, MCP latest-spec adapter, Schedule.while refinements | - | - | 132 |
| Zero external dependencies in effect core | - | - | 133 |
| Native Arbitrary generation/shrinking | Replaces previous approach | - | 133 |
| @effect/sql-pg native PgProtocol client (drops pg) | - | - | 133 |
| Pull-based Socket API; unified WebSocket client across runtimes | - | - | 133 |
| Schema.TaggedUnion partial matching; removed MessagePack & MIME dep from platform-node; CLI prompt themes | - | - | 133 |
| Effect v4 RC: August 2026 Updates recap | Blog | https://www.effect.website/blog/effect-v4-rc-august-recap | 134 |
| Perf pass (2x memory improvement core APIs), NodeSocket.makeTls, ByteSize branded bigint, PersistedQueue hardening | - | https://effect.website/docs/v4/api/effect/persistence/PersistedQueue | 134 |
| Schema.transformOrFail -> Schema.transformEffect (breaking) | - | - | 135 |
| Reactivity/LanguageModel/EmbeddingModel/Chat as interface + Context.Service; CF cold-start reduction | - | - | 135 |
| Module of the Week: PersistedQueue | Blog series | https://effect.website/blog/module-of-the-week/persisted-queue | 135 |

### Learning resources

- **Retrieval-Augmented Generation course** - build a chat-with-your-PDF app with Effect (PDF text extraction → vector storage → AI answers) - link not found - Hemanta Kumar Sundaray

| Name | Description | Link | Author | Issue |
|---|---|---|---|---|
| typeonce.dev Effect beginners course (custom runtime tip) | Course section on using a managed runtime from the start | https://www.typeonce.dev/course/effect-beginners-complete-getting-started | Sandro Maglione | 119 |
| Matt Pocock video on Effect | YouTube video | https://www.youtube.com/watch?v=S2GChOwivwQ | Matt Pocock | 119 |
| Lucas Barake videos | Effect x AI, Neverthrow vs Effect (119); Electron + Effect (123); ChatGPT app, CF Workers + RPC, Schema v4 crash course (125); GraphQL via Effect RPC (128); state library to drop Zustand (131) | https://youtube.com/watch?v=d4xza1hEs2k , https://youtube.com/watch?v=civWwuZ0wmo , https://youtube.com/watch?v=jgfS7s0XN6E | Lucas Barake | 119, 123, 125, 128, 131 |
| "One Effect to Rule them all" | How Mayflower adopted Effect (German) | https://blog.mayflower.de/29040-typescript-effect-standard-framework.html | Maria Haubner | 120 |
| How I write Effect (gen vs pipe) | Thread on style | https://twitter.com/dillon_mulroy/status/2058977944152813881 | Dillon Mulroy | 120 |
| "Effect: Make code easier for AI to write" | X article | http://x.com/i/article/2061427238621622273 | Steve Kwok | 121 |
| Effect Guide | Free guide | https://effect-guide.netlify.app/ | obadakhalili | 122 |
| Building inkpipe | Blog post | https://www.thomasdeconinck.fr/blog/2026-06-25-effect-ts-inkpipe | Thomas Deconinck | 124 |
| Effect Commander | Game teaching fibers/scheduling/retries | https://github.com/jjhiggz/learn-effect-stuff | jjhiggz | 127 |
| Community videos thread | Running X thread of community Effect videos | https://twitter.com/EffectTS_ | Effect | 127 |
| Why Effect v4 is built for AI-assisted coding | Video/essay | - | Ben Davis | 129 |
| RAG course | Chat-with-your-PDF app with Effect | https://www.effective.software/courses/rag | Hemanta Kumar Sundaray | 131 |
| Making an LLM Request in Effect TS | Blog post | https://www.jxsh.io/making-an-llm-request-in-effect-ts/ | Josh Pitzalis | 132 |
| Foldkit has server rendering | Blog post | https://foldkit.dev/blog/foldkit-has-server-rendering | Devin Jameson | 132 |
| Claude certification exercises in Effect | Rewriting Anthropic Claude cert Python exercises in Effect | https://www.jxsh.io/blog/ | Josh Pitzalis | 133 |
| Branded Types and Connascence of Execution | Blog post | https://www.dearlordylord.com/blog/branded-types-connascence-of-execution/ | Igor Loskutov | 133 |
| awesome-effect | Curated list of Effect libraries, tools, apps, learning material | https://github.com/Marve10s/awesome-effect | Ibrahim Elkamali | 133 |
| effect-isles | Grok-built educational mini-game about Effect | https://effect-isles.grok.me/ | - | 133 |
| Astra vs The Boys | Blog: 200 PRs from an AI agent sweep | https://effect.website/blog/astra-vs-the-boys | Effect team | 135 |
| Learn Effect with Craft | Guide for adopting Craft UI framework with Effect | https://craft-ts.github.io/craft/learn-effect/00-start-here | craft-ts | 135 |
| Cause & Effect Podcast #8 "Effectifying OpenCode" | Kit Langton | https://youtube.com/watch?v=-mL7VVvkLGM | Johannes Schickling | 123 |
| Cause & Effect Podcast #9 "Foldkit" | Devin Jameson | https://youtube.com/watch?v=MyKLh5CMpeY | Johannes Schickling | 128 |
| Cause & Effect Podcast #10 "Software Engineering in the Age of AI" | John A. De Goes | https://youtube.com/watch?v=irmz5X3c7Do | Johannes Schickling, Michael Arnaldi | 130 |
| Meetup talks (YouTube) | Dax Raad "Effect at OpenCode" (121); Ariel Azoulay intro (122); Leonardo Trapani "Effect at Datapizza" (123); Mattia Manzati "Stop agent slop" (124); Ariel Azoulay "Typed Agentic Runtimes", Serge Leon "NestJS to Effect", David Khourshid "State Machines with XState" (129); Maxwell Brown "Stop the agent slop", Kit Langton "Testing LLM workflows at OpenCode" (130) | https://www.youtube.com/@effect-ts | various | 121-130 |
| Kyle Mistele "Building Loops for the Real World" | AI Engineer World's Fair talk (HumanLayer) | https://www.youtube.com/live/htM02KMNZnk?t=24389s | Kyle Mistele | 128 |
| Effect Office Hours 29-45 + team shorts | Weekly streams (topics: Foldkit, Rivet, Maple.dev, OXLint/tsgo, effect-mq, RPC over WebSockets, Effect.die vs fail, logging causes, Drizzle vs Effect SQL, subtyping, optics, etc.) | https://www.youtube.com/@effect-ts | Effect team | 119-135 |

### Example apps / products built with Effect

| Name | Description | Link | Author | Issue |
|---|---|---|---|---|
| effect-coffee-shop | Onion Architecture demo, Bun + CF Workers, Vite/React, MCP | https://github.com/kevinmichaelchen/effect-coffee-shop | Kevin Chen | 119 |
| Pivit | Windows command hub with AI chat (70+ models), launcher, "Pivit Wheel" | https://pivit.app/ | - | 120 |
| Arc Work | Project | https://github.com/timhanlon/arcwork | Tim Hanlon | 124 |
| T3code | Effect-based app (SuperGrok/X subscription integration contribution) | - | - | 124 |
| X Live Studio | X's streaming command center, fully written in Effect | - | Zach Warunek | 125 |
| Birdclaw | Project built with Effect | https://github.com/steipete/birdclaw | Peter Steinberger | 125 |
| OpenGov | Talk on Effect in production at AI Engineer 2026 | - | OpenGov | 125 |
| Foldkit + Alchemy chat starter | Live chat app on CF Workers/DO, Neon, BetterAuth | - | nolan | 126 |
| Hexagonal DDD | Educational Hexagonal DDD example on Effect v4 | https://github.com/dataquail/functional-domain-driven-hexagon | Data Quail | 126 |
| effect-rpc-workers | Production-ready @effect/rpc on Cloudflare Workers example | https://github.com/ksamirdev/effect-rpc-workers | ksamirdev | 127 |
| HumanLayer | Migrating to Effect | https://www.humanlayer.dev/ | Kyle Mistele | 123 |
| dotheyplaytoday | Sports notification app (Effect + Solid) | https://github.com/jackbisceglia/dotheyplaytoday | Jack Bisceglia | 133 |
| Solid 2.0 + Effect demo | StackBlitz exploring Effect with Solid 2.0 | - | Ryan Carniato | 134 |


## Appendix: aw-applications

## Applications and examples

Open source apps that run on Effect, and templates and example projects to start from.

Part of [Awesome Effect](README.md).

### Contents

- [Applications](#applications)
- [Examples, templates, and starters](#examples-templates-and-starters)

### <img src="assets/pills/apps.svg" alt="Applications"> Applications

Open source apps and services with Effect in their stack.

- <img src="assets/icons/github.svg" alt="GitHub"> [anomalyco/opencode](https://github.com/anomalyco/opencode) - The open source coding agent. Depends on `effect`, `@effect/platform-node`, and `@effect/opentelemetry`.
- <img src="assets/icons/github.svg" alt="GitHub"> [pingdotgg/t3code](https://github.com/pingdotgg/t3code) - Coding agent client from the t3 team, built with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [pingdotgg/uploadthing](https://github.com/pingdotgg/uploadthing) - File uploads for web apps. Adopted Effect in 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [MapleTechLabs/maple](https://github.com/MapleTechLabs/maple) - OpenTelemetry observability platform for traces, logs, and metrics, built on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [marimo-team/marimo](https://github.com/marimo-team/marimo) - Reactive Python notebook. Its VS Code extension is written with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [AnswerOverflow/AnswerOverflow](https://github.com/AnswerOverflow/AnswerOverflow) - Indexes Discord threads as web pages. Large Effect v3 codebase.
- <img src="assets/icons/github.svg" alt="GitHub"> [RhysSullivan/create-epoch-app](https://github.com/RhysSullivan/create-epoch-app) - Full-stack starter with Effect, Convex, and Next.js. The same author's Effect v4 reference codebase.
- <img src="assets/icons/github.svg" alt="GitHub"> [HazelChat/hazel](https://github.com/HazelChat/hazel) - Local-first real-time chat on Effect, ElectricSQL, and React 19.
- <img src="assets/icons/github.svg" alt="GitHub"> [steipete/birdclaw](https://github.com/steipete/birdclaw) - Stores your tweets in a form agents can query.
- <img src="assets/icons/github.svg" alt="GitHub"> [zenbu-labs/zenbu.js](https://github.com/zenbu-labs/zenbu.js) - Framework for apps that users and agents modify at runtime through source editing.
- <img src="assets/icons/github.svg" alt="GitHub"> [antoine-coulon/skott](https://github.com/antoine-coulon/skott) - Analyze and visualize module dependency graphs.
- <img src="assets/icons/github.svg" alt="GitHub"> [Necmttn/ax](https://github.com/Necmttn/ax) - Local-first observability and memory for AI coding agents.
- <img src="assets/icons/github.svg" alt="GitHub"> [tenequm/pond](https://github.com/tenequm/pond) - Storage and search for AI agent sessions across clients.
- <img src="assets/icons/github.svg" alt="GitHub"> [cameronapak/dotflowy](https://github.com/cameronapak/dotflowy) - Open source Workflowy alternative.
- <img src="assets/icons/github.svg" alt="GitHub"> [BLANKSPACETS/better-pdf-reader](https://github.com/BLANKSPACETS/better-pdf-reader) - PDF and EPUB reader with a command palette and Markdown export.
- <img src="assets/icons/github.svg" alt="GitHub"> [strandhvilliam/blikka](https://github.com/strandhvilliam/blikka) - SaaS for running photo marathons.
- <img src="assets/icons/github.svg" alt="GitHub"> [robertpitt/cycle](https://github.com/robertpitt/cycle) - Local-first, agent-driven ticket system backed by a Git repo.
- <img src="assets/icons/github.svg" alt="GitHub"> [cbnsndwch/cbranch](https://github.com/cbnsndwch/cbranch) - Browser-based Git GUI.
- <img src="assets/icons/github.svg" alt="GitHub"> [chr33s/git](https://github.com/chr33s/git) - Git Smart-HTTP server, browser client, and CLI built from one core, with pull requests and SSH-signed code reviews stored as Git objects, on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [kachkaev/repo-dive](https://github.com/kachkaev/repo-dive) - Per-commit snapshots and a metrics dashboard for a repo's history, with MCP support.
- <img src="assets/icons/github.svg" alt="GitHub"> [mrtdurdenthe2/muster](https://github.com/mrtdurdenthe2/muster) - Keyboard-driven TUI for GitHub issues across repos.
- <img src="assets/icons/github.svg" alt="GitHub"> [timhanlon/arcwork](https://github.com/timhanlon/arcwork) - Unified development environment for conversations, tasks, and diffs across agent harnesses.
- <img src="assets/icons/github.svg" alt="GitHub"> [bgub/agentpane](https://github.com/bgub/agentpane) - Web interface for AI coding agents.
- <img src="assets/icons/github.svg" alt="GitHub"> [longtail-labs/slide.code](https://github.com/longtail-labs/slide.code) - Graphical environment for Claude Code. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [andresmarpz/sandcastle](https://github.com/andresmarpz/sandcastle) - Agent orchestrator for managing loops.
- <img src="assets/icons/github.svg" alt="GitHub"> [t0dorakis/murmur](https://github.com/t0dorakis/murmur) - Cron daemon for recurring agent sessions from `HEARTBEAT.md` files.
- <img src="assets/icons/github.svg" alt="GitHub"> [guillempuche/batuda](https://github.com/guillempuche/batuda) - CRM with a built-in research agent.
- <img src="assets/icons/github.svg" alt="GitHub"> [sideline-cz/sideline](https://github.com/sideline-cz/sideline) - Sports team management with a Discord-first design.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/cheffect](https://github.com/tim-smart/cheffect) - Local recipe manager and meal planner.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/receipts](https://github.com/tim-smart/receipts) - Local-first receipt scanner using GPT-4o and SQLite.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/actualbudget-sync](https://github.com/tim-smart/actualbudget-sync) - Sync bank transactions into Actual Budget.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/stremio-effect](https://github.com/tim-smart/stremio-effect) - Stremio add-on written as a learning project.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/lalph](https://github.com/tim-smart/lalph) - Agent loop runner by Tim Smart.
- <img src="assets/icons/github.svg" alt="GitHub"> [piotr-m-jurek/shipwright](https://github.com/piotr-m-jurek/shipwright) - Agent on Effect HttpApi that turns project inputs into a project brief and an implementation PRD, on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [B4rz99/fidy-ai](https://github.com/B4rz99/fidy-ai) - Agent-first personal finance for Colombia, used through WhatsApp, on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [kondaurovDev/procdeck](https://github.com/kondaurovDev/procdeck) - Runs a whole dev stack with one command, each process in a browser terminal pane with a live view of traffic between services, on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [jackbisceglia/dotheyplaytoday](https://github.com/jackbisceglia/dotheyplaytoday) - Emails you when your sports team plays today, on Effect and Solid.
- <img src="assets/icons/github.svg" alt="GitHub"> [jcfischer/supertag-cli](https://github.com/jcfischer/supertag-cli) - Tana CLI with semantic search and an MCP server.
- <img src="assets/icons/github.svg" alt="GitHub"> [kevinmichaelchen/effect-coffee-shop](https://github.com/kevinmichaelchen/effect-coffee-shop) - Coffee ordering app showing onion architecture on Bun and Cloudflare with MCP.
- <img src="assets/icons/github.svg" alt="GitHub"> [OperationalFallacy/Unleaded](https://github.com/OperationalFallacy/Unleaded) - Car listing search CLI on Ink and Effect Atom. Archived in 2026.
- <img src="assets/icons/github.svg" alt="GitHub"> [mepuka/bsky-cli](https://github.com/mepuka/bsky-cli) - Bluesky data filtering and monitoring CLI.
- <img src="assets/icons/github.svg" alt="GitHub"> [Inalegwu/Comic-Pulse](https://github.com/Inalegwu/Comic-Pulse) - Discord bot that announces comic releases.
- <img src="assets/icons/github.svg" alt="GitHub"> [kachkaev/s20-wifi-setup](https://github.com/kachkaev/s20-wifi-setup) - Connect legacy Orvibo smart sockets to Wi-Fi from the terminal.
- <img src="assets/icons/github.svg" alt="GitHub"> [davidnussio/github-stars-organizer](https://github.com/davidnussio/github-stars-organizer) - Semantic search over GitHub stars with SQLite and embeddings.
- <img src="assets/icons/github.svg" alt="GitHub"> [takeokunn/ts-minecraft](https://github.com/takeokunn/ts-minecraft) - Browser voxel game on Three.js and Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [xesrevinu/effect-event-log-isles](https://github.com/xesrevinu/effect-event-log-isles) - EventLog Isles, a creature-raising game that demonstrates Effect EventLog and Atom. [Play it](https://effect-isles.grok.me).
- <img src="assets/icons/github.svg" alt="GitHub"> [hideyuki-hori/lab-webgpu-editor](https://github.com/hideyuki-hori/lab-webgpu-editor) - Shadertoy-style WGSL editor with WebGPU.
- <img src="assets/icons/github.svg" alt="GitHub"> [DwieDave/imageresizer](https://github.com/DwieDave/imageresizer) - Browser image resizer on WebAssembly and Web Workers.
- <img src="assets/icons/github.svg" alt="GitHub"> [bettercallmanav/repaste](https://github.com/bettercallmanav/repaste) - macOS clipboard manager on Electron with event sourcing.
- <img src="assets/icons/github.svg" alt="GitHub"> [nmnmcc/Veya](https://github.com/nmnmcc/Veya) - Programmable video creation library.
- <img src="assets/icons/github.svg" alt="GitHub"> [andrueandersoncs/lion](https://github.com/andrueandersoncs/lion) - JSON-based Lisp written entirely in Effect.
- <img src="assets/icons/web.svg" alt="Website"> [Typing Terminal](https://typingterminal.com) - Multiplayer typing game built with Effect and Foldkit.
- <img src="assets/icons/web.svg" alt="Website"> [tokenmaxxing](https://tokenmaxxing.sh) - Leaderboard for LLM coding agent usage and cost, built with <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/web.svg" alt="Website"> [Pivit](https://pivit.app) - Windows command hub with AI chat and window management.
- <img src="assets/icons/web.svg" alt="Website"> [citymcp](https://citymcp.com) - Live city data for agents, built at a hackathon.
- <img src="assets/icons/web.svg" alt="Website"> [Dtapline](https://dtapline.com) - Deployment tracking and visualization.
- <img src="assets/icons/web.svg" alt="Website"> [Highlight Hunter](https://frostytools.com/highlight-hunter/about) - Finds highlights in Twitch VODs, Effect on the backend.

### <img src="assets/pills/apps.svg" alt="Applications"> Examples, templates, and starters

- <img src="assets/icons/github.svg" alt="GitHub"> [Effect-TS/examples](https://github.com/Effect-TS/examples) - Official examples.
- <img src="assets/icons/github.svg" alt="GitHub"> [jeremyosih/real-world-effect](https://github.com/jeremyosih/real-world-effect) - Open source Effect apps and templates collected in one repo for searching with agents.
- <img src="assets/icons/github.svg" alt="GitHub"> [typeonce-dev/effect-getting-started-course](https://github.com/typeonce-dev/effect-getting-started-course) - Code for the Typeonce getting started course. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [typeonce-dev/effect-backend-example](https://github.com/typeonce-dev/effect-backend-example) - Backend API with SQL and Docker setup. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [typeonce-dev/effect-react-19-project-template](https://github.com/typeonce-dev/effect-react-19-project-template) - Services, layers, and runtime for client and server code in React 19.
- <img src="assets/icons/github.svg" alt="GitHub"> [typeonce-dev/paddle-payments-full-stack-typescript-app](https://github.com/typeonce-dev/paddle-payments-full-stack-typescript-app) - Paddle Billing checkout and webhooks. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [typeonce-dev/calories-tracker-local-only-app](https://github.com/typeonce-dev/calories-tracker-local-only-app) - Local-only app on TanStack Router, PGlite, XState, and Drizzle. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [SandroMaglione/effect-getting-started](https://github.com/SandroMaglione/effect-getting-started) - Context, Layer, Runtime, and Scope examples. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [SandroMaglione/getting-started-xstate-and-effect](https://github.com/SandroMaglione/getting-started-xstate-and-effect) - XState with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [SandroMaglione/pglite-client-server](https://github.com/SandroMaglione/pglite-client-server) - Local-first Remix app on PGlite and Drizzle. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [lucas-barake/effect-electron-example](https://github.com/lucas-barake/effect-electron-example) - `@effect/rpc` and effect-atom across the Electron main and renderer boundary.
- <img src="assets/icons/github.svg" alt="GitHub"> [lucas-barake/effect-graphql-example](https://github.com/lucas-barake/effect-graphql-example) - One Effect RPC API served through GraphQL and native RPC.
- <img src="assets/icons/github.svg" alt="GitHub"> [kitlangton/effect-better-auth-example](https://github.com/kitlangton/effect-better-auth-example) - Full-stack auth with Effect, Better Auth, and React.
- <img src="assets/icons/github.svg" alt="GitHub"> [TeamWarp/effect-api-example](https://github.com/TeamWarp/effect-api-example) - Monorepo API with `@effect/platform` and Drizzle.
- <img src="assets/icons/github.svg" alt="GitHub"> [backpine/effect-worker-mono](https://github.com/backpine/effect-worker-mono) - Cloudflare Workers monorepo with shared domain models and API contracts.
- <img src="assets/icons/github.svg" alt="GitHub"> [sanurb/effect-worker-mono](https://github.com/sanurb/effect-worker-mono) - Another Cloudflare Workers monorepo template.
- <img src="assets/icons/github.svg" alt="GitHub"> [ksamirdev/effect-rpc-workers](https://github.com/ksamirdev/effect-rpc-workers) - `@effect/rpc` on Cloudflare Workers.
- <img src="assets/icons/github.svg" alt="GitHub"> [mw10013/tanstack-cloudflare-effect-shopify-app](https://github.com/mw10013/tanstack-cloudflare-effect-shopify-app) - Shopify app template on TanStack Start, Cloudflare Workers, and <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [brandhaug/b2b-saas-starter](https://github.com/brandhaug/b2b-saas-starter) - Cloudflare-first SaaS monorepo: TanStack Start, Effect v4, Drizzle on D1, Better Auth, Alchemy.
- <img src="assets/icons/github.svg" alt="GitHub"> [kevin-courbet/effect-nextjs-architecture](https://github.com/kevin-courbet/effect-nextjs-architecture) - Next.js 15 full-stack architecture with page and action builders.
- <img src="assets/icons/github.svg" alt="GitHub"> [kevin-courbet/tanstack-effect-example](https://github.com/kevin-courbet/tanstack-effect-example) - TanStack Start with Effect RPC, one query and one mutation.
- <img src="assets/icons/github.svg" alt="GitHub"> [effect-app/boilerplate](https://github.com/effect-app/boilerplate) - Boilerplate for effect-app libs.
- <img src="assets/icons/github.svg" alt="GitHub"> [jackblatch/hono-effect-starter](https://github.com/jackblatch/hono-effect-starter) - API starter on Hono, Effect, Temporal, Drizzle, and PlanetScale.
- <img src="assets/icons/github.svg" alt="GitHub"> [jimmy-guzman/hono-starter](https://github.com/jimmy-guzman/hono-starter) - REST API starter on Hono, Effect, Drizzle, and Bun.
- <img src="assets/icons/github.svg" alt="GitHub"> [Muhamed-Ragab/hono-with-effect.ts](https://github.com/Muhamed-Ragab/hono-with-effect.ts) - Hono with Effect. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [mateoroldos/sveltekit-effect-template](https://github.com/mateoroldos/sveltekit-effect-template) - SvelteKit with Effect. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [bmdavis419/effect-to-js-ex](https://github.com/bmdavis419/effect-to-js-ex) - Effect backend in a SvelteKit app crossing the boundary with typed errors.
- <img src="assets/icons/github.svg" alt="GitHub"> [denishsharma/kickr-react-effect-starter-template](https://github.com/denishsharma/kickr-react-effect-starter-template) - React, Tailwind, TanStack Router, and Vite starter. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [Guiguerreiro39/effect-monorepo](https://github.com/Guiguerreiro39/effect-monorepo) - Full-stack monorepo with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [Guiguerreiro39/trpc-effect-prisma](https://github.com/Guiguerreiro39/trpc-effect-prisma) - Next.js with tRPC, Effect, and Prisma. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [sundaray/next-effect](https://github.com/sundaray/next-effect) - AI app directory on Next.js, Hono, and Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [inioluwa-io/EffectJS-NextJS-Next-Auth-Prisma-Starter](https://github.com/inioluwa-io/EffectJS-NextJS-Next-Auth-Prisma-Starter) - Next.js, NextAuth, and Prisma starter. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [itsyasirkhandev/next_convex_firebase_template](https://github.com/itsyasirkhandev/next_convex_firebase_template) - Next.js, Convex, and Firebase Auth with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [itsyasirkhandev/clerk_convex_template](https://github.com/itsyasirkhandev/clerk_convex_template) - Next.js, Convex, and Clerk with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [dtechvision/app-templates](https://github.com/dtechvision/app-templates) - Web, Farcaster Frames, and mobile templates with Effect backends. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [Inalegwu/Gaze](https://github.com/Inalegwu/Gaze) - Effect starter template. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [juemrami/effect-starter-template](https://github.com/juemrami/effect-starter-template) - Hello world with formatter and LSP set up.
- <img src="assets/icons/github.svg" alt="GitHub"> [stvncode/effect-vite-starter](https://github.com/stvncode/effect-vite-starter) - Vite starter. Last updated 2023.
- <img src="assets/icons/github.svg" alt="GitHub"> [Oungseik/ts-starter](https://github.com/Oungseik/ts-starter) - Hono and Effect starter. Deprecated by the author.
- <img src="assets/icons/github.svg" alt="GitHub"> [miradeviar/bun-react-effect-example](https://github.com/miradeviar/bun-react-effect-example) - Bun, React 19, and Effect full-stack example.
- <img src="assets/icons/github.svg" alt="GitHub"> [rashedInt32/fullstack-effect-hive](https://github.com/rashedInt32/fullstack-effect-hive) - Real-time chat on Effect, Next.js, and PostgreSQL.
- <img src="assets/icons/github.svg" alt="GitHub"> [Mumma6/effect-node-server](https://github.com/Mumma6/effect-node-server) - Node server example. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [orlein/backend-server-effect](https://github.com/orlein/backend-server-effect) - Backend built only with Effect for a teacher's frontend students. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [f15u/effect-app](https://github.com/f15u/effect-app) - One developer's opinionated full-stack setup. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [Matechs-Digital/effect-ts-lambda](https://github.com/Matechs-Digital/effect-ts-lambda) - AWS Lambda setup from the Effect 2 era. Last updated 2022.
- <img src="assets/icons/github.svg" alt="GitHub"> [jkonowitch/hex-effect](https://github.com/jkonowitch/hex-effect) - Hexagonal architecture for DDD. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [dataquail/functional-domain-driven-hexagon](https://github.com/dataquail/functional-domain-driven-hexagon) - Hexagonal DDD on <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [tuanpt-repo/effect-ddd](https://github.com/tuanpt-repo/effect-ddd) - DDD exploration with Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [guillempuche/effect_server_react](https://github.com/guillempuche/effect_server_react) - Clean architecture: domain, use cases, repositories, SQL, and a Node server. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [guillempuche/demo_supertokens_effect](https://github.com/guillempuche/demo_supertokens_effect) - Passwordless auth with SuperTokens. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [heritageholdings/passkey-example](https://github.com/heritageholdings/passkey-example) - Passkey registration and login on Node and React Native. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [leofmarciano/encore-effect](https://github.com/leofmarciano/encore-effect) - Seven-service microservice system on Encore.ts and Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [Felipeness/holonomic-architecture](https://github.com/Felipeness/holonomic-architecture) - Fastify, Effect, and Temporal boilerplate.
- <img src="assets/icons/github.svg" alt="GitHub"> [Chahine-tech/flux](https://github.com/Chahine-tech/flux) - Canary deployments on a Temporal workflow in <img src="assets/tags/v4.svg" alt="Effect v4">
- <img src="assets/icons/github.svg" alt="GitHub"> [stevebluck/chuz](https://github.com/stevebluck/chuz) - Remix and Effect with domain-driven design. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [nickytonline/stream-for-effect](https://github.com/nickytonline/stream-for-effect) - Code from Michael Arnaldi's live-coding intro on nickyt.live. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [bishalr0y/effect-url-shortener](https://github.com/bishalr0y/effect-url-shortener) - URL shortener with Effect and Drizzle.
- <img src="assets/icons/github.svg" alt="GitHub"> [bishalr0y/effect-weather](https://github.com/bishalr0y/effect-weather) - Weather CLI on OpenWeatherMap.
- <img src="assets/icons/github.svg" alt="GitHub"> [novaru/effectful-todo](https://github.com/novaru/effectful-todo) - Todo app with Effect, Hono, and Drizzle.
- <img src="assets/icons/github.svg" alt="GitHub"> [sixthextinction/effect-ts-scraping](https://github.com/sixthextinction/effect-ts-scraping) - Fault-tolerant web data pipeline with proxies.
- <img src="assets/icons/github.svg" alt="GitHub"> [surya-git-kgp/effective-etl](https://github.com/surya-git-kgp/effective-etl) - ETL framework on Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [lloydrichards/edu_effect-okf](https://github.com/lloydrichards/edu_effect-okf) - CLI tools on Effect v4 that parse and query OKF bundles.
- <img src="assets/icons/github.svg" alt="GitHub"> [lloydrichards/proj_okf-graph](https://github.com/lloydrichards/proj_okf-graph) - CLI that turns the Markdown links between OKF concept files into a directed graph to query and validate.
- <img src="assets/icons/github.svg" alt="GitHub"> [lloydrichards/base_bevr-stack](https://github.com/lloydrichards/base_bevr-stack) - Bun, Elysia, Vite, React, and Effect stack.
- <img src="assets/icons/github.svg" alt="GitHub"> [lambda-mike/mars-rover-kata](https://github.com/lambda-mike/mars-rover-kata) - Mars rover kata. Last updated 2022.
- <img src="assets/icons/github.svg" alt="GitHub"> [devmatteini/imperative-to-effect-kata](https://github.com/devmatteini/imperative-to-effect-kata) - Refactoring kata from imperative code to Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [devmatteini/from-fp-ts-to-effect-ts](https://github.com/devmatteini/from-fp-ts-to-effect-ts) - Effect from an fp-ts user's perspective. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [ruizb/adventofcode2022](https://github.com/ruizb/adventofcode2022) - Advent of Code 2022 in Effect. Last updated 2023.
- <img src="assets/icons/github.svg" alt="GitHub"> [LeoSM-07/adventofcode-2025](https://github.com/LeoSM-07/adventofcode-2025) - Advent of Code 2025 in Effect.
- <img src="assets/icons/github.svg" alt="GitHub"> [tim-smart/aoc25](https://github.com/tim-smart/aoc25) - Tim Smart's Advent of Code 2025 solutions.


## Appendix: aw-learning

## Learning Effect

Courses, patterns, articles, talks, and podcast episodes about Effect.

Part of [Awesome Effect](README.md).

### Contents

- [Courses and guides](#courses-and-guides)
- [Patterns and reference](#patterns-and-reference)
- [Articles](#articles)
- [Videos and talks](#videos-and-talks)
- [Podcasts](#podcasts)

### <img src="assets/pills/learning.svg" alt="Learning"> Courses and guides

- <img src="assets/icons/web.svg" alt="Website"> [Effect Institute](https://www.effect.institute) - Tutorial series by Kit Langton.
- <img src="assets/icons/web.svg" alt="Website"> [Effect Solutions](https://www.effect.solutions) - Prescriptive idioms for writing Effect, with agent instructions to copy. Source in [kitlangton/effect-solutions](https://github.com/kitlangton/effect-solutions).
- <img src="assets/icons/web.svg" alt="Website"> [Typeonce courses](https://www.typeonce.dev) - Sandro Maglione's courses, including [Effect: Beginners Complete Getting Started](https://www.typeonce.dev/course/effect-beginners-complete-getting-started), [React 19 + Effect project template](https://www.typeonce.dev/course/effect-react-19-project-template), and [Paddle payments full-stack app](https://www.typeonce.dev/course/paddle-payments-full-stack-typescript-app).
- <img src="assets/icons/web.svg" alt="Website"> [Effective Software courses](https://www.effective.software/courses) - Free courses by Hemanta Kumar Sundaray on Effect foundations, Schema v4, HttpClient, HTTP API, configuration, Atom, and RAG.
- <img src="assets/icons/web.svg" alt="Website"> [Practical Effect](https://lucasbarake.com) - Course by Lucas Barake.
- <img src="assets/icons/web.svg" alt="Website"> [Effect by Example](https://effectbyexample.com) - Short examples for common scenarios.
- <img src="assets/icons/article.svg" alt="Article"> [Effect for TypeScript Developers](https://tonytangdev.github.io/effect-for-ts-developers) - 33-step guide by Tony Tang.
- <img src="assets/icons/web.svg" alt="Website"> [Effect Guide](https://effect-guide.netlify.app) - Free guide by obadakhalili.
- <img src="assets/icons/web.svg" alt="Website"> [effect.ninja](https://effect-way-course--jonas127.replit.app) - Interactive course by Jonas Templestein.
- <img src="assets/icons/github.svg" alt="GitHub"> [Effect Commander](https://github.com/jjhiggz/learn-effect-stuff) - Game that teaches fibers, scheduling, and retries by making you use them.
- <img src="assets/icons/github.svg" alt="GitHub"> [pigoz/effect-crashcourse](https://github.com/pigoz/effect-crashcourse) - The practical guide the author wished existed when learning. Last updated 2024.
- <img src="assets/icons/github.svg" alt="GitHub"> [antoine-coulon/effect-introduction](https://github.com/antoine-coulon/effect-introduction) - Why Effect, for developers moving from plain TypeScript. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [kiliancs/effect-workshop](https://github.com/kiliancs/effect-workshop) - Explanations and exercises for beginners. Last updated 2025.
- <img src="assets/icons/github.svg" alt="GitHub"> [cardotrejos/effect-interactive-lab](https://github.com/cardotrejos/effect-interactive-lab) - Interactive React examples contrasting Effect with async/await.
- <img src="assets/icons/github.svg" alt="GitHub"> [Effect Days 2025 workshop](https://github.com/Effect-TS/effect-days-2025-workshop) - Official workshop exercises. Last updated 2025.
- <img src="assets/icons/web.svg" alt="Website"> [Advent of Effect](https://adventofeffect.com) - Solve Advent of Code with Effect alongside the Discord.
- <img src="assets/icons/web.svg" alt="Website"> [justfuckinguseeffect.dev](https://justfuckinguseeffect.dev) - Single-page argument for using Effect.
- <img src="assets/icons/web.svg" alt="Website"> [Effect vs fp-ts](https://effect.website/docs/additional-resources/effect-vs-fp-ts/) - Official comparison for fp-ts users.

### <img src="assets/pills/learning.svg" alt="Learning"> Patterns and reference

- <img src="assets/icons/github.svg" alt="GitHub"> [PaulJPhilp/EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns) - Community knowledge base of practical patterns, 300 and counting.
- <img src="assets/icons/article.svg" alt="Article"> [ethanniser.dev/blog/effect-best-practices](https://ethanniser.dev/blog/effect-best-practices) - Best practices from an Effect Days workshop instructor.
- <img src="assets/icons/article.svg" alt="Article"> [Thoughtworks Technology Radar: Effect](https://www.thoughtworks.com/radar/languages-and-frameworks/effect) - Radar entry from Vol. 32.
- <img src="assets/icons/article.svg" alt="Article"> [Effect on dev.to](https://dev.to/effect-ts) - Official dev.to organization.

### <img src="assets/pills/learning.svg" alt="Learning"> Articles

- <img src="assets/icons/article.svg" alt="Article"> [Comprehensive guide to Effect usage in TypeScript](https://www.sandromaglione.com/articles/complete-introduction-to-using-effect-in-typescript) - Sandro Maglione.
- <img src="assets/icons/article.svg" alt="Article"> [From fp-ts to Effect: migration guide](https://www.sandromaglione.com/articles/from-fp-ts-to-effect-ts-migration-guide) - Sandro Maglione.
- <img src="assets/icons/article.svg" alt="Article"> [How to implement a backend with Effect](https://www.typeonce.dev/article/how-to-implement-a-backend-with-effect) - Sandro Maglione. HttpApi, routing, PostgreSQL, and a derived client.
- <img src="assets/icons/article.svg" alt="Article"> [Effect RPC HTTP client complete example](https://www.typeonce.dev/snippet/effect-rpc-http-client-complete-example) - Sandro Maglione.
- <img src="assets/icons/article.svg" alt="Article"> [Authentication with JWT access and refresh tokens](https://www.typeonce.dev/snippet/authentication-jwt-access-and-refresh-tokens-with-effect) - Sandro Maglione.
- <img src="assets/icons/article.svg" alt="Article"> [A gentle introduction to Effect TS](https://blog.mavnn.co.uk/2024/09/16/intro_to_effect_ts.html) - Michael Newton. Adopting Effect in a greenfield project.
- <img src="assets/icons/article.svg" alt="Article"> [The truth about Effect](https://ethanniser.dev/blog/the-truth-about-effect) - Ethan Niser. Effect as a language for effectful computation.
- <img src="assets/icons/article.svg" alt="Article"> [The difficulty of complexity](https://ethanniser.dev/blog/the-difficulty-of-complexity) - Ethan Niser. Compares Effect's adoption curve to early React.
- <img src="assets/icons/article.svg" alt="Article"> [Is the Effect tax worth it?](https://dev.to/datner/the-effect-tax-3gn0) - Yuval Datner on adopting Effect on the frontend.
- <img src="assets/icons/article.svg" alt="Article"> [How we migrated our codebase from fp-ts to Effect](https://dev.to/laurerc/how-we-migrated-our-codebase-from-fp-ts-to-effect-5bbk) - The inato team, two months end to end.
- <img src="assets/icons/article.svg" alt="Article"> [How I replaced tRPC with Effect RPC in a Next.js App Router application](https://dev.to/titouancreach/how-i-replaced-trpc-with-effect-rpc-in-a-nextjs-app-router-application-4j8p) - Titouan Créac'h. [Part 2 on streaming responses](https://dev.to/titouancreach/part-2-how-i-replaced-trpc-with-effect-rpc-in-a-nextjs-app-router-application-streaming-responses-566c).
- <img src="assets/icons/article.svg" alt="Article"> [Exploring Effect in TypeScript: simplifying async and error handling](https://www.tweag.io/blog/2024-11-07-typescript-effect/) - Douglas Massolari at Tweag writes the same app twice.
- <img src="assets/icons/article.svg" alt="Article"> [Why we chose Effect for building Spiko](https://tech.spiko.io/posts/why-we-chose-effect) - Samuel Briole, CTO of Spiko.
- <img src="assets/icons/article.svg" alt="Article"> [Building with Effect and EdgeDB](https://www.geldata.com/blog/building-with-effect-and-edgedb-part-1) - Aleksandra Sikora.
- <img src="assets/icons/article.svg" alt="Article"> [One Effect to rule them all](https://blog.mayflower.de/29040-typescript-effect-standard-framework.html) - Maria Haubner on Mayflower's adoption from `@effect/schema` outward.
- <img src="assets/icons/article.svg" alt="Article"> [Effect TS: the new standard for building production APIs](https://blog.type-driven.com/effect-ts-new-standard) - Type Driven.
- <img src="assets/icons/article.svg" alt="Article"> [Building a fault-tolerant web data ingestion pipeline with Effect-TS](https://javascript.plainenglish.io/building-a-fault-tolerant-web-data-ingestion-pipeline-with-effect-ts-0bc5494282ba) - Typed errors, resources, and retry policies.
- <img src="assets/icons/article.svg" alt="Article"> [Getting started with tracing in Effect](https://mattrossman.com/2025/02/17/getting-started-with-tracing-in-effect) - Matt Rossman.
- <img src="assets/icons/article.svg" alt="Article"> [Writing dual APIs with Effect](https://mattrossman.com/2025/03/23/writing-dual-apis-with-effect) - Matt Rossman.
- <img src="assets/icons/article.svg" alt="Article"> [Building a composable policy system in TypeScript with Effect](https://lucas-barake.github.io/building-a-composable-policy-system) - Lucas Barake.
- <img src="assets/icons/article.svg" alt="Article"> [Supporting offline mode in TanStack Query](https://lucas-barake.github.io/persisting-tantsack-query-data-locally) - Lucas Barake on Effect Schema for persistence.
- <img src="assets/icons/article.svg" alt="Article"> [Effective pragmatism](https://dev.to/attila_vecerek/effective-pragmatism-introduction-5dc7) - Blog series by Attila Večerek of Zendesk.
- <img src="assets/icons/article.svg" alt="Article"> [Designing with types: the TypeScript Effect approach](https://akhansari.tech/series/designing-with-types-typescript-effect-approach) - Domain modeling series by Amin Khansari.
- <img src="assets/icons/article.svg" alt="Article"> [Making an LLM request in Effect TS](https://www.jxsh.io/making-an-llm-request-in-effect-ts) - Josh Pitzalis.
- <img src="assets/icons/article.svg" alt="Article"> [Building inkpipe](https://www.thomasdeconinck.fr/blog/2026-06-25-effect-ts-inkpipe) - Thomas Deconinck.
- <img src="assets/icons/article.svg" alt="Article"> [Schema is all you need](https://mattiamanzati.github.io/schema-is-all-you-need) - Mattia Manzati's React Alicante slides with live-coding transcript.
- <img src="assets/icons/article.svg" alt="Article"> [TypeScript validators jamboree](https://monadical.com/posts/typescript-validators-jamboree.html) - Igor Loskutov compares validation libraries, Effect Schema included.
- <img src="assets/icons/article.svg" alt="Article"> [Branded types and connascence of execution](https://www.dearlordylord.com/blog/branded-types-connascence-of-execution/) - Igor Loskutov.
- <img src="assets/icons/article.svg" alt="Article"> [StudioCMS Beta 19: an Effectful update](https://studiocms.dev/blog/beta-19-release) - Migration write-up. Also [Beta 31: from Drizzle to Kysely](https://studiocms.dev/blog/beta-31-release) and [v0.1.0](https://studiocms.dev/blog/v0-1-release).
- <img src="assets/icons/article.svg" alt="Article"> [Foldkit has server rendering](https://foldkit.dev/blog/foldkit-has-server-rendering) - Devin Jameson. Also [Foldkit vs React side by side](https://foldkit.dev/foldkit-vs-react-side-by-side).
- <img src="assets/icons/article.svg" alt="Article"> [Alessandro Maclaine's Option series on dev.to](https://dev.to/almaclaine) - Matching, sequencing, zipping, combining, folding, filtering, and lifting with Option.
- <img src="assets/icons/article.svg" alt="Article"> [Building robust TypeScript APIs with the Effect ecosystem](https://dev.to/martinpersson/building-robust-typescript-apis-with-the-effect-ecosystem-1m7c) - Martin Persson. Also [a type-safe GraphQL backend with Effect and Drizzle](https://dev.to/martinpersson/building-a-robust-backend-with-effect-graphql-and-drizzle-k4j).
- <img src="assets/icons/article.svg" alt="Article"> [Breaking down Effect TS](https://dev.to/modgil_23/breaking-down-effect-ts-part-1-2e0i) - Two-part FP foundations series.
- <img src="assets/icons/article.svg" alt="Article"> [Effects in TypeScript: a new way to build robust backends](https://merginit.com/blog/27062025-effects-in-typescript) - Merginit.
- <img src="assets/icons/article.svg" alt="Article"> [Astra vs. The Boys: a tale of 200 PRs](https://effect.website/blog/astra-vs-the-boys) - Michael Arnaldi on 207 agent-written pull requests against the Effect codebase in three days, and the review agents built to handle them.

### <img src="assets/pills/learning.svg" alt="Learning"> Videos and talks

- <img src="assets/icons/video.svg" alt="Video"> [Effect YouTube channel](https://www.youtube.com/@effect-ts) - Talks, workshops, the podcast, and Effect Office Hours, the live sessions with the core team.
- <img src="assets/icons/video.svg" alt="Video"> [Effect Days 2024 playlist](https://www.youtube.com/playlist?list=PLDf3uQLaK2B_XZ8k3gD8R1k4-LBz8JmHP) - 15 talks and 2 workshops from Vienna.
- <img src="assets/icons/video.svg" alt="Video"> [Effect Days 2025 playlist](https://www.youtube.com/playlist?list=PLDf3uQLaK2B9vHzUNyvOSvoMv61LW7792) - 19 talks and 2 workshops from Livorno.
- <img src="assets/icons/video.svg" alt="Video"> [Effect: the origin story](https://www.youtube.com/watch?v=7sJc3Z4mh1w) - Michael Arnaldi, Effect Days 2024.
- <img src="assets/icons/video.svg" alt="Video"> [Effect: a functional foundation for TypeScript](https://www.youtube.com/watch?v=BHuY6w9ed5o) - Michael Arnaldi, LambdaConf 2024.
- <img src="assets/icons/video.svg" alt="Video"> [Introduction to Effect](https://www.youtube.com/watch?v=zrNr3JVUc8I) - Michael Arnaldi, WorkerConf 2022.
- <img src="assets/icons/video.svg" alt="Video"> [Effect Days 2024 beginner and intermediate workshop](https://www.youtube.com/watch?v=Lz2J1NBnHK4) - Ethan Niser.
- <img src="assets/icons/video.svg" alt="Video"> [Effect Days 2024 advanced workshop](https://www.youtube.com/watch?v=7jOD5okJC00) - Maxwell Brown.
- <img src="assets/icons/video.svg" alt="Video"> [Production-grade app architecture with Effect](https://www.youtube.com/watch?v=upXJJ9maWPc) - Maxwell Brown, Effect Days 2025 workshop part 1.
- <img src="assets/icons/video.svg" alt="Video"> [Incremental adoption of Effect](https://youtu.be/LEiNtsMMo8c) - Tim Smart, Effect Days 2025 workshop part 2.
- <img src="assets/icons/video.svg" alt="Video"> [Structured concurrency](https://youtu.be/do5KCcCgS18) - Effect Days 2025.
- <img src="assets/icons/video.svg" alt="Video"> [Effect on the frontend](https://youtu.be/G_jp87gxILE) - Effect Days 2025.
- <img src="assets/icons/video.svg" alt="Video"> [MasterClass' AI voice chat](https://youtu.be/foPXd8T6Ido) - David Golightly, Effect Days 2025.
- <img src="assets/icons/video.svg" alt="Video"> [Effect for AWS Lambda](https://youtu.be/Cg8Hv5nN1-A) - Effect Days 2025.
- <img src="assets/icons/video.svg" alt="Video"> [Simplifying forms with Effect](https://youtu.be/RieDcO_LJik) - Effect Days 2025.
- <img src="assets/icons/video.svg" alt="Video"> [Effect: next-generation TypeScript](https://www.youtube.com/watch?v=SloZE4i4Zfk) - Ethan Niser, 2023.
- <img src="assets/icons/video.svg" alt="Video"> [Effect for beginners](https://www.youtube.com/watch?v=fTN8BX5qj6s) - Ethan Niser, 2023.
- <img src="assets/icons/video.svg" alt="Video"> [Effect-ful computations with fibers](https://www.youtube.com/watch?v=uwALExyq4NY) - Early talk on the fiber model.
- <img src="assets/icons/video.svg" alt="Video"> [Effect: the unreadable library that captured my heart](https://www.youtube.com/watch?v=S2GChOwivwQ) - Matt Pocock, 2025.
- <img src="assets/icons/video.svg" alt="Video"> [Learning EffectJS: learning in the age of AI](https://www.youtube.com/watch?v=O2__t8lceCg) - ThePrimeagen, 2026.
- <img src="assets/icons/video.svg" alt="Video"> [Building reliable support agents using the Effect TypeScript library](https://www.youtube.com/@aiDotEngineer) - Michael Fester at AI Engineer.
- <img src="assets/icons/video.svg" alt="Video"> [Why my coding agents use Effect](https://youtu.be/s6uAUvAaRN0) - Parker Landon.
- <img src="assets/icons/video.svg" alt="Video"> [Stop the agent slop with Effect](https://www.youtube.com/watch?v=b8ULm238DHg) - Maxwell Brown, 2026.
- <img src="assets/icons/video.svg" alt="Video"> [Testing LLM workflows with Effect at OpenCode](https://www.youtube.com/watch?v=EBSOGU-65c4) - Kit Langton, 2026.
- <img src="assets/icons/video.svg" alt="Video"> [Effective state machines with XState](https://www.youtube.com/watch?v=m-dSS55VO3Y) - David Khourshid, Effect Miami 2. Also from the same meetup: [How to switch to Effect for NestJS devs](https://www.youtube.com/watch?v=MlKoIo0oQwk) by Serge Leon and [Typed agentic runtimes and workflows](https://www.youtube.com/watch?v=07edR9TwrJA) by Ariel Azoulay.
- <img src="assets/icons/video.svg" alt="Video"> [Theo on Effect in his stack](https://youtu.be/3c4UyGRBnmM) - Around 43:55.
- <img src="assets/icons/video.svg" alt="Video"> [Lucas Barake's channel](https://www.youtube.com/@lucas-barake) - Long-form videos on RPC, workers, permissions, and more.
- <img src="assets/icons/video.svg" alt="Video"> [Ben Davis's channel](https://www.youtube.com/@bmdavis419) - Includes "My favorite TypeScript library just got so much better".
- <img src="assets/icons/video.svg" alt="Video"> [Web Village Voyage](https://www.youtube.com/@webvv) - Video guides on Effect values.
- <img src="assets/icons/video.svg" alt="Video"> [Sign Language Tech](https://www.youtube.com/@SignLanguageTech) - Effect guides in sign language by Milad Vafaeifard.
- <img src="assets/icons/video.svg" alt="Video"> [SvelteKit and Effect with Dillon Mulroy](https://www.youtube.com/@SvelteSociety) - Svelte Society.
- <img src="assets/icons/article.svg" alt="Article"> [TDC Floripa 2025 slides](https://speakerdeck.com/talyssonoc/tdc-floripa-2025-abordagens-funcionais-efetivas-em-typescript-com-effect-ts) - Talysson Oliveira Cassiano's intro talk, in Portuguese.

### <img src="assets/pills/learning.svg" alt="Learning"> Podcasts

- <img src="assets/icons/podcast.svg" alt="Podcast"> [Cause & Effect](https://effect.website/podcast) - Official podcast. [YouTube](https://youtube.com/playlist?list=PLDf3uQLaK2B_jaZ5Fy7IPNq0FIViV_CQl), [Spotify](https://open.spotify.com/show/4QTFiem4o0G9V2vXtv8vMU), [Apple Podcasts](https://podcasts.apple.com/us/podcast/cause-effect/id1781879869).
  - Ep. 1: Adopting Effect at Zendesk, with Attila Večerek.
  - Ep. 2: Scaling AI for customer support at Markprompt, with Michael Fester.
  - Ep. 3: Scaling voice AI at MasterClass, with David Golightly.
  - Ep. 4: From skeptic to advocate, scaling Effect at Vercel, with Dillon Mulroy.
  - Ep. 5: Event-driven systems in fintech at Spiko, with Samuel Briole.
  - Ep. 6: Inside OpenRouter's tech stack, with Louis Vichy.
  - Ep. 7: Reliable payroll systems in TypeScript, with Adam Rankin.
  - Ep. 8: Effectifying OpenCode, with Kit Langton.
  - Ep. 9: Foldkit, an Effect-first frontend framework, with Devin Jameson.
  - Ep. 10: Software engineering in the age of AI, with John A. De Goes.
- <img src="assets/icons/podcast.svg" alt="Podcast"> [Happy Path Programming: Effects and local-first with Johannes Schickling](https://podcasters.spotify.com/pod/show/happypathprogramming/episodes/101-Effects-and-Local-First-with-Johannes-Schickling-e2lkhkj) - James Ward and Bruce Eckel.
- <img src="assets/icons/video.svg" alt="Video"> [Happy Path Programming with Sam Goodwin on Alchemy](https://www.youtube.com/@HappyPathProgramming) - Infrastructure as Effects.
- <img src="assets/icons/podcast.svg" alt="Podcast"> [syntax.fm](https://syntax.fm) - Episode with Johannes Schickling on Effect as TypeScript's missing library.
- <img src="assets/icons/podcast.svg" alt="Podcast"> [nickyt.live](https://nickyt.live) - Michael Arnaldi introduces Effect through live coding.
