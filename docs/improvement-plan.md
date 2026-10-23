# Transport and provider composition improvement plan

Status: Phases 1-3 and 5 implemented; Phase 4 deprecation deferred

This document records the composition work. The overall service and feature
roadmap is now `docs/service-improvement-plan.md`, with the current API inventory
in `docs/baseline-inventory.md` and the lifecycle decision in
`docs/adr/0001-delivery-lifecycle.md`.

Implementation status (2026-10-22):

- Phase 1 complete: `TransportRegistry`, `Email.layerFromRegistry`, tests.
- Phase 2 verified: provider client layers already derive transports from one
  client instance; added sharing tests and a provider surface conformance test.
- Phase 3 complete: README route-registry guidance and package exports updated.
- Phase 4 deprecation/removal not started.
- Phase 5 verification complete: typecheck, 270 tests, build, dist smoke, and
  package dry-run pass.
- Follow-up fixes: ambiguous HTTP request failures are `DeliveryUncertain`,
  `withRetry` preserves native batches, and SQL transitions use transaction-local
  state.

Scope: the `Transport`, `EmailTransport`, provider client, layer, and route
composition model. Provider feature parity and delivery semantics are out of
scope unless they affect composition.

Related documents:

- `docs/service-improvement-plan.md`
- `docs/baseline-inventory.md`
- `docs/adr/0001-delivery-lifecycle.md`
- `docs/review-findings.md`
- `docs/review-plan.md`
- `docs/runtime-matrix.md`
- `docs/driver-parity.md`

## 1. Current state

### Transport

`src/EmailTransport.ts` defines `Transport` as a value:

```ts
interface Transport {
  readonly destination: Destination
  readonly capabilities: TransportCapabilities
  readonly send: (envelope) => Effect<SubmissionReceipt, TransportError>
  readonly retrieve?: ...
  readonly cancel?: ...
}
```

It also defines a single-transport service:

```ts
class EmailTransport extends Context.Service<EmailTransport, Transport>()
```

### Email routing

`src/Email.ts` accepts static transport values:

```ts
Email.layer({
  defaultFrom,
  routes: { default: transport }
})
```

Routes are captured when the layer is built. There is no route-keyed service.

### Providers

Provider modules use several patterns:

- `make(options): Effect<Transport, never, HttpClient>`
- `layer(options): Layer<EmailTransport, never, HttpClient>`
- Some providers also expose:
  - `Client` service
  - `makeClient`
  - `layerClient`
  - `layerTransport`
  - `layerWithClient`

Examples include `src/providers/Resend.ts`, `src/providers/Postmark.ts`, and
`src/providers/SendGrid.ts`.

### Problems

1. Every provider exposing `EmailTransport` makes the service ambiguous when
   more than one provider is configured.
2. `Email.layer` does not consume provider layers or services, so provider
   `layer` APIs are not the primary composition path.
3. Provider-specific clients and generic transports can be acquired separately,
   risking duplicate state or duplicate resource acquisition.
4. Naming is inconsistent across providers.
5. There is no route-keyed service for dynamic route resolution or overrides.
6. Users must choose between two mental models: static transport values or
   `EmailTransport` layers.

## 2. Decisions

### D1: Keep `Transport` as a value

Do not turn `Transport` into a service. It is a capability object and policy
input, not an ambient dependency. Values compose cleanly with retry, fallback,
round-robin, tee, tests, and multiple routes.

### D2: Add a route-keyed `TransportRegistry` service

Routes should be resolvable through a service without collapsing all providers
into one `EmailTransport` tag.

```ts
export interface TransportRegistryShape {
  readonly get: (
    route: RouteName
  ) => Effect.Effect<Transport, UnsupportedCapability>
  readonly routes: Effect.Effect<ReadonlyArray<RouteName>>
}

export class TransportRegistry extends Context.Service<
  TransportRegistry,
  TransportRegistryShape
>()("@effect-email/TransportRegistry") {}
```

Add a static registry layer for the existing route-map API:

```ts
TransportRegistry.layer({
  default: transport,
  bulk: secondary
})
```

### D3: Keep `Email.layer({ routes })`

Do not break the common static configuration path. Internally it can build or
consume a registry.

### D4: Add `Email.layerFromRegistry`

```ts
Email.layerFromRegistry({
  defaultFrom,
  defaultRoute,
  registry
})
```

The registry is resolved during layer construction, preserving the current
`Email` API contract with no per-call environment requirements.

### D5: Provider services are provider-specific

A provider-specific `Client` service is useful for native operations such as
batch, retrieve, cancel, scheduling, or provider-only payloads. It must not
replace the generic `Transport`.

Standard shape:

```ts
export interface ProviderClient {
  readonly transport: Transport
}

export const makeClient: (
  options: ProviderOptions
) => Effect.Effect<ProviderClient, never, HttpClient.HttpClient>

export const layerClient: (
  options: ProviderOptions
) => Layer.Layer<ProviderClient, never, HttpClient.HttpClient>

export const layerTransport: (
  options: ProviderOptions
) => Layer.Layer<EmailTransport, never, HttpClient.HttpClient>
```

`layerTransport` derives the transport from the same client instance. It does
not call `makeClient` a second time.

### D6: `EmailTransport` remains a single-provider convenience

`EmailTransport` is retained for applications that use exactly one transport.
It is not the multi-provider composition model. Documentation and examples must
make that distinction explicit.

### D7: Do not force every provider to expose a client service

Providers with no provider-specific operations may continue to expose only
`make`/`layer`. Standardize the naming and resource-sharing guarantees, not the
presence of a client service.

## 3. Target API

### Registry

```ts
import * as TransportRegistry from "@doeixd/effect-email/TransportRegistry"

const registry = yield* TransportRegistry.make({
  default: resendTransport,
  transactional: postmarkTransport
})

const emailLayer = Email.layerFromRegistry({
  defaultFrom: "billing@example.com",
  defaultRoute: routeName("default"),
  registry
})
```

### Provider client

```ts
import * as Resend from "@doeixd/effect-email/providers/Resend"

const resendLayer = Resend.layerClient({
  apiKey: Redacted.make(process.env.RESEND_API_KEY!)
}).pipe(Layer.provide(FetchHttpClient.layer))

const program = Effect.gen(function* () {
  const client = yield* Resend.Client
  const transport = client.transport
  const receipt = yield* Email.send(message).pipe(
    Effect.provide(Email.layer({ routes: { default: transport } }))
  )
})
```

### Single transport

```ts
const single = Resend.layerTransport(options).pipe(
  Layer.provide(FetchHttpClient.layer)
)
```

This remains a convenience for one-provider applications.

## 4. Workstreams

### Phase 0: Inventory and compatibility

Files:

- `src/EmailTransport.ts`
- `src/Email.ts`
- Every `src/providers/*.ts`
- Provider tests

Tasks:

- [ ] Inventory every provider export: `make`, `makeClient`, `Client`,
  `layer`, `layerClient`, `layerTransport`, `layerWithClient`, `layerConfig`.
- [ ] Record which providers have provider-specific operations.
- [ ] Decide which exports are canonical, compatibility aliases, or deprecated.
- [ ] Identify tests that assert layer/service behavior.
- [ ] Define the `TransportRegistry` contract and error behavior.

Exit:

- Provider export matrix.
- Compatibility policy for existing imports.

### Phase 1: Add `TransportRegistry`

Files:

- New `src/TransportRegistry.ts`
- `src/Email.ts`
- `src/index.ts`
- `package.json`
- `test/TransportRegistry.test.ts`
- `test/Packaging.test.ts`

Tasks:

- [ ] Implement `TransportRegistry` service.
- [ ] Add `TransportRegistry.layer` for static route maps.
- [ ] Add `Email.layerFromRegistry`.
- [ ] Keep `Email.layer({ routes })` behavior unchanged.
- [ ] Validate duplicate, missing, and unknown routes.
- [ ] Add root/subpath export and packaging checks.

Acceptance:

- Static route behavior is unchanged.
- Registry-based Email resolves the same transport for each route.
- Unknown routes produce `UnsupportedCapability`.
- Root entrypoint remains free of Node/provider imports.

### Phase 2: Normalize provider composition

Files:

- All provider modules
- Provider tests

Tasks:

- [ ] Standardize `makeClient`/`layerClient` for providers with native
  operations.
- [ ] Ensure `layerTransport` derives from `layerClient`, not a second
  acquisition.
- [ ] Keep `make` and `layer` compatibility aliases.
- [ ] Add a shared provider-client interface where it reduces duplication.
- [ ] Verify one acquisition and one release for `layerWithClient`.
- [ ] Document provider-specific clients as optional native accessors.

Acceptance:

- No provider calls `make` twice for one composed layer.
- Provider-specific client and generic transport share state.
- Existing provider imports continue to compile.

### Phase 3: Email integration and examples

Files:

- `src/Email.ts`
- `README.md`
- `examples/*`
- `docs/runtime-matrix.md`

Tasks:

- [x] Add a registry example with two providers.
- [x] Document static `routes` versus registry routes.
- [x] Document `EmailTransport` as a single-provider convenience.
- [x] Update provider examples to prefer canonical client/transport APIs.
- [x] Add a migration note for users with custom provider layers.

Migration note: existing provider `layer`/`layerTransport` imports continue to
work for single-provider applications. Custom providers that expose
`EmailTransport` should stay single-route; multi-route applications should wrap
them in `TransportRegistry` instead of providing several transports under the
same tag.

Acceptance:

- Docs explain the two composition models without contradiction.
- Examples compile and run where local.
- No example recommends a colliding `EmailTransport` layer for multiple routes.

### Phase 4: Deprecation and cleanup

Files:

- Provider modules
- `README.md`
- `CHANGELOG.md`

Tasks:

- [ ] Mark redundant layer aliases as deprecated in documentation and types.
- [ ] Keep compatibility through at least one minor release.
- [ ] Remove only after a documented migration window.
- [ ] Update the release checklist and changelog.

Acceptance:

- Deprecated paths are explicit.
- No silent removal of public exports.
- Migration instructions are tested or typechecked.

### Phase 5: Verification and release

Commands:

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
npm pack --dry-run
```

Additional tests:

- [x] Registry route isolation.
- [ ] Two-provider registry with fallback/round-robin.
- [x] Provider layer acquisition count.
- [x] Root entrypoint packaging.
- [x] PostgreSQL and queue tests remain green.

## 5. Provider export matrix

Fill this during Phase 0.

| Provider | make | Client | layerClient | layerTransport | Native operations |
| --- | --- | --- | --- | --- | --- |
| AhaSend | | | | | |
| Azure Communication | | | | | |
| Brevo | | | | | |
| Cloudflare Email | | | | | |
| Cloudflare Email REST | | | | | |
| Cloudflare Email Service | | | | | |
| Generic HTTP | | | | | |
| Loops | | | | | |
| Mailbreeze | | | | | |
| MailChannels | | | | | |
| Mailcrab | | | | | |
| MailerSend | | | | | |
| Mailgun | | | | | |
| Mailjet | | | | | |
| Mailpit | | | | | |
| Mailtrap | | | | | |
| Mock | | | | | |
| Postmark | | | | | |
| Resend | | | | | |
| Scaleway | | | | | |
| SendGrid | | | | | |
| SES | | | | | |
| SMTP | | | | | |
| SMTP2GO | | | | | |
| ZeptoMail | | | | | |

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Registry adds a second route model | Keep `Email.layer({ routes })` as the default and implement it through the registry |
| Provider-specific services proliferate | Only add clients where native operations exist |
| Duplicate resource acquisition | Make `layerTransport` derive from `layerClient`; add acquisition-count tests |
| Breaking public imports | Keep compatibility aliases and document deprecation |
| Root entrypoint leakage | Extend packaging tests for the registry and provider subpaths |
| Dynamic route semantics diverge from static routes | Share the same route resolution and error mapping code |
| Layer memoization assumptions | Test one resource acquisition with `Layer.provideMerge` |

## 7. Definition of done

- `TransportRegistry` is implemented, exported, and tested.
- `Email.layerFromRegistry` works with static and custom registries.
- `Email.layer({ routes })` remains compatible.
- Provider client/layer naming is documented and consistent.
- Providers with native operations share one client instance with their transport.
- `EmailTransport` is documented as single-provider convenience, not the
  multi-route model.
- README and examples show both composition models.
- All tests, build, smoke, and package checks pass.
- No new Critical or High review finding is introduced.
