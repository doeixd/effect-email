# Effect Schema (v4) — API & Ecosystem (researched 2026-09-16)

Companion to [effect-v4-api-scope.md](effect-v4-api-scope.md) and [effect-ecosystem.md](effect-ecosystem.md). Based on `effect@4.0.0-rc.115` source, the official guide `packages/effect/SCHEMA.md` (~7.2k lines, https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md) and `migration/schema.md` (v3→v4).

**History:** `@effect/schema` (standalone) → merged into `effect/Schema` in 3.10 → redesigned for v4 ("Schema 2"). v4 is a major API change: fewer variadic args, transformations as first-class objects, and separate decode/encode requirements.

## Modules (all in core `effect`)
| Module | Role |
|---|---|
| `Schema` | Main API: primitives, composites, filters, transformations, classes, codecs, decode/encode, derivations |
| `SchemaAST` | Untyped AST nodes (annotations, checks, encoding links, context) for library authors |
| `SchemaGetter` | Single-direction getters used inside transformations (`transform`, `transformEffect`, `parseJson`, `split`, `trim`, base64/hex, FormData, URLSearchParams…) |
| `SchemaTransformation` | Reusable bidirectional `Transformation` / `Middleware` objects (`numberFromString`, `dateFromString`, `optionFromNullOr`, `fromJsonString`…) |
| `SchemaIssue` | Error tree (`InvalidType`, `InvalidValue`, `MissingKey`, `UnexpectedKey`, `Composite`, `Pointer`, `AnyOf`, `OneOf`, `Forbidden`) and formatters (`makeFormatterDefault`, `makeFormatterStandardSchemaV1`) |
| `SchemaParser` | Low-level decode/encode runners |
| `SchemaRepresentation` | Serializable schema representation: persist schemas as JSON, rebuild runtime schemas (`fromRepresentation` + revivers), JSON Schema import/export, **codegen** (`toCodeDocument`) |
| `JsonSchema` | JSON Schema draft-04/07/2020-12 and OpenAPI 3.0/3.1 conversion (`fromSchemaDraft07`, `fromSchemaOpenApi3_1`, `toDocumentDraft07`, `toMultiDocumentOpenApi3_1`) |
| `StandardSchema` | Standard Schema V1 types; `Schema.toStandardSchemaV1`, `Schema.toStandardJSONSchemaV1` |
| `unstable/arbitrary` `Arbitrary` | fast-check arbitraries from schemas (native generation and shrinking since TWIE #133) |
| `unstable/schema` `Model`, `VariantSchema` | Multi-variant models (`Model.Class` with select/insert/update/json variants, `Model.GeneratedByDb`…) used by SQL/HttpApi |
| Related: `Optic`, `Differ`/`JsonPatch`, `Equivalence`, `Formatter` | Derivations from schemas |

## Type model
- `Codec<T, E, RD, RE>`: decoded type, encoded type, **decoding services**, **encoding services** (v3 had a single `R`).
- Hierarchy: `Top` → `Schema<T>` → `Codec<T,E,RD,RE>` → `Bottom<…15 params>` (tracks mutability/optionality/constructor defaults per side). Use `Top`/`Schema`/`Codec` only as **constraints**, not return-type annotations.

## Core API cheat sheet
- **Primitives:** `String Number Boolean BigInt Symbol Null Undefined Void Unknown Any Never ObjectKeyword`, `Literal(x)`, `Literals([...])`, `Enum`, `TemplateLiteral([...])`, `TemplateLiteralParser`, `UniqueSymbol`.
- **Composites:** `Struct({...})`, `StructWithRest`, `Record(key, value)`, `Tuple([...])`, `TupleWithRest`, `Array`, `NonEmptyArray`, `UniqueArray`, `ArrayEnsure`, `Union([...])`, `NullOr/UndefinedOr/NullishOr`, `suspend` (recursion), `TaggedStruct`, `TaggedUnion`, `toTaggedUnion` (adds `.match`, guards).
- **Fields:** `optionalKey` (exact), `optional` (`| undefined`), `requiredKey`, `mutableKey`, `encodeKeys` (rename encoded keys), `fieldsAssign`, `schema.mapFields(Struct.pick/omit/map/assign)`, `withDecodingDefault(Key|Type|TypeKey)`, `withConstructorDefault`, `tag`, `tagDefaultOmit`.
- **Validation:** `.check(Schema.isMinLength(3), …)`, `makeFilter`, `makeFilterGroup`, `refine` (type-narrowing), `brand`; many built-in `is*` filters (UUID, ULID, pattern, int, between, multipleOf, base64, date/bigint/BigDecimal ranges, size/length, unique…). Filters are first-class values, can report multiple issues, can abort, and can be effectful.
- **Transformations:** `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))`, `decode`/`encode`/`encodeTo`, `SchemaGetter.transformEffect` for effectful/failing logic (`transformOrFail` was renamed `transformEffect` in TWIE #135), `flip`, `passthrough*`, `toType`, `toEncoded`.
- **Middlewares:** `catchDecoding` (fallbacks, replaces `decodingFallback`), `middlewareDecoding/Encoding` (inject services).
- **Classes:** `Schema.Class`, `TaggedClass`, `Error`, `TaggedError` (the standard Effect error type), `Opaque` (opaque struct type without a class runtime), `instanceOf`, `declare` / `declareConstructor` (custom and parametric types, with `toCodecJson` support).
- **Built-in data types:** Date/`DateFromString`/`DateFromMillis`, `DateTimeUtc*`, `DateTimeZoned*`, `TimeZone*`, `Duration*`, `BigDecimal*`, `ByteSize*`, `NumberFromString`, `FiniteFromString`, `Trim/Trimmed`, `StringFromBase64/Hex/UriComponent`, `Uint8Array*`, `URL*`, `RegExp`, `File`, `FormData`, `URLSearchParams`, `Option*` (`OptionFromNullOr`, `OptionFromOptionalKey`…), `Result`, `Exit`, `Cause`, `Redacted`/`RedactedFromValue`, `Chunk`, `HashMap`, `HashSet`, `ReadonlyMap/Set`, `Graph`, network types (`Ipv4Address`, `IpNetwork`, `MacAddress`, `SocketAddress`…), `Cookie(s)`, `Headers`, `UrlParams`, `Json`/`MutableJson`, `Defect`, `ErrorInstance`.
- **Decoding and encoding:** `decodeUnknown{Effect,Exit,Option,Result,Promise,Sync}` and `decode{…}` (typed input); the same set for `encode*`; `is`, `asserts(schema, input)`, `schema.make(input)` constructors. v3 names map as `decodeUnknown`→`decodeUnknownEffect` and `*Either`→`*Exit`/`*Result`. `validate*` was removed.
- **Serialization codecs:** `toCodecJson` (canonical JSON codec for any schema, e.g. BigInt→string), `toCodecStringTree` (query strings and form params), `toCodecIso`, `fromJsonString`, `UnknownFromJsonString`, `fromFormData`, `fromURLSearchParams`, `toEncoderXml`, `toCodecArrayFromSingle`.
- **Derivations:** `toJsonSchemaDocument` (draft-07 / 2020-12, reference strategies), `toStandardSchemaV1`, `toStandardJSONSchemaV1`, `toEquivalence`, `toFormatter`, `toIso/toIsoSource/toIsoFocus` (Optics), `toDifferJsonPatch`, `toRepresentation`, `Arbitrary`.
- **Annotations:** `annotate({ title, description, examples, … })` (typed), `annotateKey`, `annotateEncoded` (applies to the encoded side).
- **Parsing options:** errors `"first"|"all"`, `onExcessProperty`, concurrent product parsing.

## v3 → v4 key renames (from migration/schema.md)
| v3 | v4 |
|---|---|
| `Union(A,B)`, `Tuple(A,B)`, `Literal("a","b")` | `Union([A,B])`, `Tuple([A,B])`, `Literals(["a","b"])` |
| `Record({key,value})` | `Record(key, value)` |
| `annotations()` | `annotate()` |
| `compose` | `decodeTo` |
| `typeSchema` / `encodedSchema` / `asSchema` | `toType` / `toEncoded` / `revealCodec` |
| `filter(pred)` / `filter(refinement)` | `check(makeFilter(pred))` / `refine(ref)` |
| `pattern(re)`, `nonEmptyString` | `check(isPattern(re))`, `isNonEmpty` |
| `transform(from,to,{decode,encode})` | `from.pipe(decodeTo(to, SchemaTransformation.transform({decode,encode})))` |
| `transformOrFail` | `decodeTo(to, { decode: SchemaGetter.transformEffect(...), encode: ... })` |
| `pick/omit/partial/extend` | `mapFields(Struct.pick/omit/map(optional)/assign)` or `fieldsAssign` |
| `optionalWith(s,{exact})` / `{default}` | `optionalKey(s)` / `withDecodingDefaultType(...)` |
| `*FromSelf` (`BigIntFromSelf`, `URLFromSelf`, `EitherFromSelf`) | plain name (`BigInt`, `URL`, `Result`) |
| `Date` (string-encoded) | `DateFromString` (`Date` is now the Date instance) |
| `DateFromNumber` | `DateFromMillis` |
| `Redacted` / `RedactedFromSelf` | `RedactedFromValue` / `Redacted` |
| `parseJson(s)` | `fromJsonString(s)` |
| `decodingFallback` | `catchDecoding` |
| `ParseResult` formatters | `SchemaIssue` formatters |
| removed | `validate*`, `keyof`, `Data(schema)`, `withDefaults`, `NonEmptyArrayEnsure` |
The official `effect-v3-to-v4` skill (Effect-TS/skills) and the migration tooling from TWIE #129 automate much of this.

## Performance (official, schema-benchmarks suite, µs/op, lower is better)
Effect Schema leads on parsing invalid data while collecting errors (9.1 vs Valibot 15.7 vs Zod 41.6) and on validating or parsing valid data (~5.3–5.4). It trails Valibot on stop-early invalid paths and Zod 4 on typed codecs (0.34 vs 0.04). Schema creation costs 118 (Valibot 40, Zod 318). Suite: https://github.com/open-circle/schema-benchmarks

## Official integrations documented in SCHEMA.md
- **TanStack Form:** pass `Schema.toStandardSchemaV1(schema)` as the validator; fields are parsed as well as validated.
- **Elysia:** Standard Schema for params, query and body (`toCodecStringTree` for string inputs, `toCodecJson` for JSON), plus `@elysiajs/openapi` `mapJsonSchema: { effect: s => Schema.toJsonSchema(...) }`.
- **Standard Schema:** makes Effect Schema usable anywhere Standard Schema is accepted (tRPC, oRPC, Hono standard-validator, TanStack Router/Form, t3-env, react-hook-form standard resolver, AI SDKs…).
- **Inside Effect:** HttpApi (`HttpApiSchema`, OpenAPI generation), Rpc, `unstable/sql` (`SqlSchema`, `Model`), Config, CLI args, AI `Tool` params and structured output (`AnthropicStructuredOutput`, `OpenAiStructuredOutput`), `ChannelSchema` / `Stream` NDJSON / `SchemaBinary`, cluster messages, `KeyValueStore.forSchema`, and `Persistable`.

## Ecosystem
**Status summary (2026-09-16):** most third-party Schema adapters still target v3. Adapters that allow v4: `drizzle-orm@rc` `./effect-schema`, official `@effect/openapi-generator`, `conform-to-effect`, `effect-graphql`. For everything else, prefer **Standard Schema** (`Schema.toStandardSchemaV1`), which works with TanStack Form, oRPC, tRPC, t3-env, Hono standard-validator and GQLoom on any Effect version, so dedicated adapters are largely unnecessary. Dead or superseded: effect-schema-compilers, ts-to-effect-schema (effect 2.x), drizzle-effect (unpublished; use the Drizzle native export), effect-http (use HttpApi).

## Effect Schema third-party ecosystem (checked 2026-09-16)

Stars and last push come from `gh api`. Versions and peer deps come from `npm view`. "v3" means `effect` ^3.x peer/dep, "v4" means >=4.0.0-beta. Items marked UNVERIFIED were not confirmed with registry or repo data.
Note: v4 `Schema.toStandardSchemaV1` / v3 `Schema.toStandardSchemaV1` lets any Standard Schema consumer accept Effect Schema directly (TanStack Form, oRPC, t3-env, tRPC, GQLoom, and others).

### Forms
| Name | Repo | npm | Stars | Push | Effect | Notes |
|---|---|---|---|---|---|---|
| @hookform/resolvers (effectTsResolver) | https://github.com/react-hook-form/resolvers | @hookform/resolvers 5.9.1 | 2260 | 2026-08-17 | v3 (peer ^3.10.3) | react-hook-form resolver |
| effect-form (Lucas Barake) | https://github.com/lucas-barake/effect-form | @lucas-barake/effect-form 0.25.0 | 134 | 2026-07-10 | v3 (^3.19.15) | Type-safe React forms with Effect Schema |
| effect-form (savkelita) | https://github.com/savkelita/effect-form | effect-form 0.1.0 | 1 | 2026-08-20 | v3 (^3.19.15) | Small form lib |
| conform-to-effect | https://github.com/carloitaben/conform-to-effect | conform-to-effect 1.0.1 | 5 | 2026-08-13 | **v4** (>=4.0.0-beta.102) | Conform helpers |
| sveltekit-superforms (effect adapter) | https://github.com/ciscoheat/sveltekit-superforms | sveltekit-superforms 2.30.2 | 2782 | 2026-08-27 | v3 (optional peer ^3.21.0) | SvelteKit forms |
| TanStack Form | https://github.com/TanStack/form | @tanstack/react-form 1.33.5 | 6686 | 2026-09-16 | any (Standard Schema) | No effect peer; works through standardSchemaV1 |

### OpenAPI / JSON Schema / codegen
| Name | Repo | npm | Stars | Push | Effect | Notes |
|---|---|---|---|---|---|---|
| @effect/openapi-generator | https://github.com/Effect-TS/effect-smol | @effect/openapi-generator 4.0.0-beta.107 | (monorepo) | - | **v4** | Official OpenAPI to Effect Schema/HttpApi client codegen |
| openapi-to-effect | https://github.com/fortanix/openapi-to-effect | openapi-to-effect 0.9.3 | 49 | 2025-11-28 | v3 (dep ^3.13.12) | OpenAPI to Schema codegen (Fortanix) |
| schema-openapi | https://github.com/sukovanej/schema-openapi | schema-openapi 0.39.1 | 16 | 2024-06-23 | v3 (^3.4.0) | Schema to OpenAPI compiler; stale, superseded by HttpApi |
| effect-http | https://github.com/sukovanej/effect-http | effect-http | 289 | 2025-03-22 | v3 | Schema-first HTTP + OpenAPI; archived in practice |
| json-schema-effect | https://github.com/spencerbeggs/json-schema-effect | json-schema-effect 0.3.0 | 0 | 2026-07-18 | v3 (^3.21.0) | JSON Schema to/from Effect tooling |
| effect-schema-compilers | https://github.com/jessekelly881/effect-schema-compilers | effect-schema-compilers 0.0.23 | 22 | 2024-10-14 | effect 2.4.7 (dead) | Faker, Semigroup and other compilers |
| ts-to-effect-schema | https://github.com/daotl/ts-to-effect-schema | ts-to-effect-schema 0.0.13 | 7 | 2026-05-09 | effect 2.3.6 in npm | TS types to Schema codegen |
| effect-types | https://github.com/jessekelly881/effect-types | - | 15 | 2024-01-15 | old @effect/schema | Extra schema types |
| Built-in: `Schema.toJsonSchemaDocument` and `SchemaRepresentation` (v4), `JSONSchema.make` (v3) | core | effect | - | - | v3 + v4 | Official JSON Schema output |
| @hey-api/openapi-ts Effect plugin | https://github.com/hey-api/openapi-ts | @hey-api/openapi-ts 0.99.0 | - | - | UNVERIFIED | Unconfirmed whether an Effect plugin exists |
| json-schema-to-effect, zod-to-effect, effect-schema-to-zod | - | not on npm (404) | - | - | UNVERIFIED | No package found under these names |

### ORM / DB
| Name | Repo | npm | Stars | Push | Effect | Notes |
|---|---|---|---|---|---|---|
| drizzle-orm `./effect-schema` | https://github.com/drizzle-team/drizzle-orm | drizzle-orm@1.0.0-rc.4 | - | - | **v4** (>=4.0.0-beta.83) | Native table to Schema export plus effect-* drivers (stable 0.45.2 has none) |
| drizzle-effect | https://github.com/Handfish/drizzle-effect | unpublished from npm 2025-04 | 17 | 2025-06-03 | v3 | Drizzle to Schema generator; superseded by native export |
| effect-sql-model | https://github.com/emergente-labs/effect-sql-model | - | 19 | 2026-05-28 | UNVERIFIED | Schema/Model to Drizzle table compiler |
| @effect/sql-drizzle, @effect/sql-kysely | Effect-TS/effect | 0.51.0 / 0.48.0 | - | - | v3 only | Official; v4 SQL lives in `effect/sql` |
| confect | https://github.com/rjdellecese/confect | @confect/core 9.4.3 | 362 | 2026-09-15 | v3 (^3.21.2) | Convex DB schemas and validators from Effect Schema |
| Prisma generator | - | prisma-effect-generator 404 | - | - | UNVERIFIED | No maintained package found |

### HTTP / RPC validators
| Name | Repo | npm | Stars | Push | Effect | Notes |
|---|---|---|---|---|---|---|
| @hono/effect-validator | https://github.com/honojs/middleware | @hono/effect-validator 1.2.0 | 994 (monorepo) | 2026-09-16 | peer >=3.10.0 (v4 compat UNVERIFIED) | Hono validator middleware |
| oRPC | https://github.com/middleapi/orpc | @orpc/server 1.15.1 | 5623 | 2026-09-16 | any (Standard Schema) | No dedicated effect adapter in npm metadata |
| tRPC | https://github.com/trpc/trpc | @trpc/server | - | - | Standard Schema | Accepts standardSchemaV1 |
| effect-trpc | UNVERIFIED repo | effect-trpc 1.2.3 | - | - | v3 (^3.0.0) | tRPC/Effect bridge |
| fastify-type-provider-effect-schema | https://github.com/daotl/fastify-type-provider-effect-schema | 0.0.4 | 7 | 2026-07-30 | UNVERIFIED | Fastify type provider |
| typed-at-rest | https://github.com/TheDevMinerTV/typed-at-rest | - | 12 | 2026-09-16 | UNVERIFIED | Typed HTTP handlers/clients |
| @typeschema/effect | https://github.com/decs/typeschema | 0.14.0 | 452 | 2024-10-14 | v3 (^3.6.5) | Universal adapter; replaced by Standard Schema |

### Env validation
| t3-env | https://github.com/t3-oss/t3-env | @t3-oss/env-core 0.13.11 | 4005 | 2026-04-01 | Standard Schema | Effect Schema works through standardSchemaV1. The native option is Effect `Config`. |

### GraphQL
| Name | Repo | npm | Stars | Push | Effect | Notes |
|---|---|---|---|---|---|---|
| effect-graphql | https://github.com/egriff38/effect-graphql | effect-graphql 0.2.1 | 1 | 2026-08-01 | **v4** (^4.0.0-beta.74) | GraphQL schema from Effect Schema |
| GQLoom | https://github.com/modevol-com/gqloom | @gqloom/effect (UNVERIFIED name) | - | - | UNVERIFIED | Code search shows it uses standardSchemaV1 |
| effect-domain | https://github.com/mac-monet/effect-domain | - | - | - | UNVERIFIED | REST/RPC/GraphQL from one definition (from ecosystem doc) |

### Test data
- Built-in `Arbitrary.make` (fast-check) in v3 and v4. fast-check 4.10.1 has no effect peer.
- Faker: effect-schema-compilers (dead, effect 2.x). No current faker package found (effect-schema-faker returns 404).

### Serialization formats
- effect-schema-avro: https://github.com/AMar4enko/effect-schema-avro, 8 stars, pushed 2025-05-13, not on npm, v3.
- Protobuf: nothing found (UNVERIFIED).

### AI structured output
- Official: `@effect/ai` 0.37.0 (v3), `effect/ai` (v4). Both use Schema for tools and structured output.
- Vercel AI SDK: accepts Standard Schema / JSON Schema. Effect Schema works through `standardSchemaV1` or `jsonSchema(JSONSchema.make(...))`. A native adapter is UNVERIFIED.

### Schema-driven libraries (from docs/effect-ecosystem.md and search)
| Name | Repo | Stars | Push | Notes |
|---|---|---|---|---|
| effect-machine (typeonce) | https://github.com/typeonce-dev/effect-machine | 195 | 2026-09-14 | Schema-first statecharts |
| effect-machine (cevr) | https://github.com/cevr/effect-machine | 71 | 2026-09-07 | Schema-first state machines |
| effect-delta | https://github.com/kitlangton/effect-delta | 38 | 2026-06-07 | Schema-derived patches (not on npm) |
| templeffect | https://github.com/TylorS/templeffect | 26 | 2025-03-02 | Schema-based templating |
| effect-temporal | https://github.com/TeamSpringbird/effect-temporal | 21 | 2026-09-11 | Temporal workflows with schemas |
| effect-cf | https://github.com/jbt95/effect-cf | 22 | 2026-08-15 | Cloudflare clients with schema validation |
| redfx, effect-mq, effect-inngest, effect-agent | see docs/effect-ecosystem.md | - | - | Schema-validated payloads |
| Experimental Schema compiler | https://github.com/Effect-TS/effect/pull/7908 | - | - | Official opt-in compiler PR (Giulio Canti) |

### Benchmarks
- typescript-runtime-type-benchmarks: https://github.com/moltar/typescript-runtime-type-benchmarks, 831 stars, pushed 2026-09-15. Whether it includes Effect Schema is UNVERIFIED (not checked).

### Not found / UNVERIFIED
- i18n error formatting libraries, VS Code extensions for Schema, zod/valibot interop converters, and Prisma generators: no packages found.
