# Effect dependency strategy

The package currently pins exact stable Effect versions:

```json
{
  "effect": "4.0.6",
  "@effect/platform-node": "4.0.6",
  "@effect/platform-node-shared": "4.0.6",
  "@effect/sql-pg": "4.0.6",
  "@effect/sql-sqlite-node": "4.0.6",
  "@effect/vitest": "4.0.6"
}
```

The `@effect/platform-node-shared` override keeps one shared runtime instance.

## Why exact pins

- The package exposes Effect services, schemas, layers, and workflow APIs. A
  second Effect instance in the application would break service identity.
- Exact pins make compatibility failures explicit instead of silently mixing
  versions.
- The integration tests exercise SQL, HTTP, SMTP, workflow, and queue layers
  against the pinned versions.

## Before widening ranges

Do not mechanically switch to `peerDependencies`. First verify:

1. Supported Effect ranges compose to one runtime instance.
2. Package-manager resolution behaves correctly for npm, pnpm, and Bun.
3. Installed tarball imports work for root, provider, gateway, workflow, and
   SMTP subpaths.
4. Node HTTP/SMTP bindings work on the supported Node versions.
5. CI covers the lowest and highest supported ranges.

## Effect Language Service

`@effect/language-service` is installed as a development dependency and enabled
in `tsconfig.json`. Run:

```sh
bun run effect:diagnostics
```

CI should keep this at zero errors. The current baseline has two informational
`Effect.succeed(undefined)` suggestions where the return type intentionally
includes `undefined`.

## Tarball smoke

Before release:

```sh
npm pack --dry-run
npm pack
```

Install the generated tarball in a clean temporary project and import:

- `@doeixd/effect-email`
- `@doeixd/effect-email/providers/Resend`
- `@doeixd/effect-email/server/Gateway`
- `@doeixd/effect-email/workflow/Submissions`
- `@doeixd/effect-email/smtp/Node`

Run the built `scripts/smoke.mjs` as well. The root entrypoint must remain free
of provider, server, SMTP, and Node-only imports.
