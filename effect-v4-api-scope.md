---
name: effect-v4-api-scope
description: "Effect-TS v4 (effect@4.0.0-rc.115, Sept 2026) module map, v3→v4 renames, idioms, companion packages"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4793989c-3af5-47bd-98fc-74dfa80756c0
  modified: 2026-09-16T12:24:54.662Z
---

# Effect v4 — API scope reference (researched 2026-09-16)

**Version status:** npm `latest` is still v3 (3.22.2). v4 ships on `rc` tag: `effect@4.0.0-rc.115` (2026-09-11); `beta` tag stale (beta.107). Install with `npm i effect@rc`.
Reqs: TS ≥5.9 (TS7/tsgo recommended), `strict: true`, Node ≥18.
**Best source of truth:** the npm package itself ships `AGENTS.md`, `CLAUDE.md`, and `ai-docs/src/**` (runnable examples by topic) plus full `src/`. `npm pack effect@rc` and read them. API docs: https://effect.website/docs/v4/api/effect

## Big structural change
The ecosystem is consolidated into **one `effect` package**. Old `@effect/platform`, `@effect/rpc`, `@effect/cluster`, `@effect/sql`, `@effect/cli`, `@effect/ai`, `@effect/workflow`, `@effect/experimental`, `@effect-atom/atom` → now `effect/<area>` (under `effect/unstable/*` until 4.0.0). APIs tagged `@stability unstable` may break in minors.
Separate packages remain only for platform/driver/provider bindings, all versioned in lockstep (4.0.0-rc.115): `@effect/platform-node|bun|browser`, `@effect/vitest`, `@effect/sql-pg|sql-sqlite-node|…`, `@effect/ai-openai|ai-anthropic`, `@effect/atom-react`, `@effect/opentelemetry`.

Package exports (4.0.0): `effect`, `effect/<Module>`, `effect/testing`, and `effect/{ai,cli,cluster,devtools,encoding,eventlog,http,http-api,net,observability,persistence,process,reactivity,rpc,schema,socket,sql,workflow,workers}`. `Arbitrary` moved to the top level (`import { Arbitrary } from 'effect'`).

## Core (`import { X } from "effect"`)
- **Core runtime:** Effect, Effectable, Exit, Cause, Fiber, FiberHandle/FiberMap/FiberSet, Runtime, ManagedRuntime, Scheduler, Scope, References, ErrorReporter, ExecutionPlan
- **DI:** Context (replaces v3 Context.Tag/Effect.Service — `Context.Service`, `Context.Reference`), Layer, LayerMap, LayerRef
- **Errors/data:** Data, Result (**replaces Either**), Option, UndefinedOr, Filter, Predicate, Match, Brand, Newtype, Redacted, Redactable
- **Schema family:** Schema, SchemaAST, SchemaGetter, SchemaIssue, SchemaParser, SchemaTransformation, SchemaRepresentation, JsonSchema, StandardSchema (Schema is in core since v3.10; v4 is the redesigned "Schema 2")
- **Concurrency:** Deferred, Latch, Semaphore, PartitionedSemaphore, Queue, PubSub, Ref, SynchronizedRef, SubscriptionRef, MutableRef, Pool, RcRef, RcMap, ScopedRef, Resource
- **STM → Tx\*:** TxRef, TxQueue, TxPubSub, TxHashMap, TxHashSet, TxChunk, TxDeferred, TxSemaphore, TxReentrantLock, TxPriorityQueue, TxSubscriptionRef (v3 STM/TRef/TMap gone)
- **Streaming:** Stream, Channel, ChannelSchema, Sink, Pull, Take
- **Scheduling/time:** Schedule, Clock, Duration, DateTime, Cron
- **Caching/batching:** Cache, ScopedCache, Request, RequestResolver
- **Config/obs:** Config, ConfigProvider, Logger, LogLevel, Metric, Tracer, Console
- **Platform abstractions (moved from @effect/platform):** FileSystem, Path, Terminal, Stdio, PlatformError, Crypto
- **Data structures/std:** Array, Chunk, Iterable, NonEmptyIterable, Record, Struct, Tuple, String, Number, BigInt, BigDecimal, Boolean, RegExp, Symbol, HashMap, HashSet, HashRing, MutableHashMap, MutableHashSet, MutableList, Trie, Graph, Order, Ordering, Equivalence, Equal, Hash, PrimaryKey, Combiner, Reducer, Differ, Optic, JsonPatch, JsonPointer, Encoding, ByteSize, Formatter, Inspectable, Random
- **Type utils:** Function (pipe, flow, dual), Pipeable, Types, Unify, Utils, HKT
- Removed vs v3 (noted): Either, STM/T*, Micro, List, SortedMap etc. — verify before assuming presence.

## Unstable modules (`import { HttpClient } from "effect/http"`)
- **http:** HttpClient, FetchHttpClient, HttpClientRequest/Response/Error, HttpServer, HttpRouter, HttpMiddleware, HttpServerRequest/Response, HttpStaticServer, Headers, Cookies, Multipart, Url, UrlParams, Etag, Mime, Template
- **httpapi:** HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiBuilder, HttpApiClient, HttpApiMiddleware, HttpApiSecurity, HttpApiError, HttpApiSchema, OpenApi, HttpApiSwagger, HttpApiScalar, HttpApiTest (in-memory test client)
- **rpc:** Rpc, RpcGroup, RpcServer, RpcClient, RpcMiddleware, RpcSerialization, RpcWorker, RpcTest
- **sql:** SqlClient, Statement, SqlSchema, SqlResolver, SqlModel, Migrator, SqlStream; **schema:** Model (`Model.Class` variants for db/json), VariantSchema
- **cli:** Command, Argument, Flag, GlobalFlag, Prompt, HelpDoc, Completions
- **ai:** LanguageModel, Chat, Prompt, Response, Tool, Toolkit, EmbeddingModel, Tokenizer, Model, AiError, McpServer/McpSchema
- **cluster:** Entity, Sharding, ShardingConfig, Runner(s), Singleton, ClusterCron, MessageStorage (+Sql), HttpRunner/SocketRunner, K8sHttpClient
- **workflow:** Workflow, Activity, WorkflowEngine, DurableClock, DurableDeferred, DurableQueue
- **reactivity** (ex effect-atom): Atom, AtomRegistry, AtomRef, AsyncResult, AtomHttpApi, AtomRpc, Hydration, Reactivity
- **persistence:** KeyValueStore, PersistedCache, PersistedQueue, RateLimiter, Redis
- **observability:** Otlp, OtlpTracer/Logger/Metrics, PrometheusMetrics (lightweight, preferred over @effect/opentelemetry for new projects)
- **process:** ChildProcess, ChildProcessSpawner; **socket:** Socket, SocketServer; **workers:** Worker, WorkerRunner; **encoding:** Ndjson, Sse, Yaml, Toml, Ini, SchemaBinary; **eventlog** (local-first sync); **devtools**; **net**; **arbitrary** (fast-check)

## Idioms / renames (verified in source)
- Services: `class Db extends Context.Service<Db, { query(...): Effect<...> }>()("myapp/db/Db") { static readonly layer = Layer.effect(Db, Effect.gen(...return Db.of({...}))) }`. Service type: `Db["Service"]`. Defaults: `Context.Reference`.
- Errors: `class E extends Schema.TaggedError<E>()("E", {...}) {}`; `return yield* new E(...)`.
- `Effect.catchAll` → **`Effect.catch`**; also `catchTag` (accepts array of tags), `catchTags`, `catchCause`, `catchDefect`, `catchIf`, `catchFilter`, `catchReason(s)` + `unwrapReason` for nested "reason" errors.
- `Effect.either` → **`Effect.result`** (Result type).
- `Effect.fork` → **`Effect.forkChild`**; `forkDaemon` → **`forkDetach`**; `forkScoped`, `forkIn`.
- Functions: `Effect.fn("name")(function*(x): Effect.fn.Return<A,E> {...}, ...combinators)` (traced; don't `.pipe` it) ; `Effect.fnUntraced` for hot/lib code.
- Layers: `Layer.provide`, `Layer.provideMerge`, `Layer.unwrap` (layer from Effect/Config), `Layer.effectDiscard` (background tasks), `Layer.launch`.
- Run: `NodeRuntime.runMain` (@effect/platform-node), `ManagedRuntime.make(layer)` for framework integration.
- Stream: `Stream.callback` (was async), `fromEventListener`, `paginate`, `pipeThroughChannel` with Ndjson.
- Tests: `@effect/vitest` `it.effect`, `layer(...)`.
- Use `DateTime` over `Date`; `Predicate.isX` over hand-written guards; Schema for all parsing.

Related: [[effect-best-practices skill exists but may target v3 — check against this]]
