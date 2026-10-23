# Routing diagnostics

`Routing.explain` evaluates prepared messages against candidate transports
without sending anything. It reports hard requirements, capability rejections,
and explicit preferences.

```ts
import * as Routing from "@doeixd/effect-email/Routing"

const explanation = yield* Routing.explain(prepared, {
  candidates: [
    { route: primaryRoute, transport: primary },
    { route: secondaryRoute, transport: secondary }
  ],
  route: primaryRoute,
  prefer: ["nativeBatch"]
})
```

## Requirements and preferences

Hard requirements come from the prepared message:

- raw MIME
- local or provider-hosted templates
- attachments and remote attachment URLs
- tags
- recipient count

An unmet hard requirement rejects the candidate with an
`UnsupportedCapability` reason.

`prefer: ["nativeBatch"]` is only a preference. It annotates eligible candidates
with a `nativeBatch` preference; it never overrides a hard requirement.

## Explicit routes

When `route` is provided, candidates outside that route are ineligible even if
they support the message. Capability-aware routing must not silently escape a
tenant's explicit route, provider region, or account.

## Provider templates

Provider-hosted template IDs are destination-bound. `Routing.explain` does not
translate template IDs between providers. An explicit mapping must exist before
a provider template can be considered portable.

## Sending

`Routing.explain` is diagnostic only. It performs no network I/O. Actual sending
continues through `Email.send`, `Email.sendBatch`, or the durable admission path,
which revalidates capabilities before dispatch.
