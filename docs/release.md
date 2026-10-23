# 0.3.0 release checklist

Package: `@doeixd/effect-email`. This release follows the published 0.2 series;
unpublished development version labels are consolidated into 0.3.0.

Read the [changelog](../CHANGELOG.md) and [upgrade guide](./upgrading-0.3.md)
before deployment. Existing installations must apply migrations through `0008`
and drain or explicitly migrate pending workflows before switching workflow
identities. Custom delivery stores must implement the new event-wait methods.

## Qualification record

Checked on 2026-10-23 with Node 22.23.1, Bun 1.4.4, and an isolated PostgreSQL 16
instance. Node bindings require Node 22.19.0 or newer, matching the HTTP runtime
dependency's minimum. The development Node major is selected by `.nvmrc`.

| Gate | Result |
| --- | --- |
| Frozen Bun dependency install | Passed |
| Build and TypeScript checks | Passed |
| Tests with PostgreSQL enabled | 369 passed across 65 files; no skips |
| Effect diagnostics | Zero errors, zero warnings, two informational suggestions |
| Built-package and tarball smoke checks | Passed |
| Clean npm consumer install, public imports, and Mock send | Passed; one deduplicated Effect 4.0.6 runtime |
| Mock quick start, provider-layer, and routing examples | Passed |
| SQL migrations `0001`–`0008` on PostgreSQL 16 | Passed on a fresh database and on a second application |

Provider fixtures establish contract coverage. Live provider sandboxes and
concurrent-worker production load qualification have not been run as release
gates. Concurrent PostgreSQL transaction isolation has integration coverage.

## Reproduce the checks

Use Node 22.19+ and Bun, with `DATABASE_URL` pointing at a disposable PostgreSQL
16 database. PostgreSQL tests are skipped when that variable is absent.

```sh
bun install --frozen-lockfile
bun run check
bun run effect:diagnostics
bun run smoke
bun run smoke:tarball
bun examples/quick-start.ts
bun examples/provider-layer.ts
bun examples/routes.ts
npm pack --json
```

`prepack` rebuilds `dist/` and runs the built-package smoke check. The tarball
smoke check validates package identity, declarations, README links, migrations,
and imports. It removes its temporary archive; run the final `npm pack` afterward
to retain `doeixd-effect-email-0.3.0.tgz` for review and publication.

Confirm the archive contains:

- JavaScript and declarations in `dist/`, plus `src/` for source maps.
- SQL migrations `0001` through `0008`.
- `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, and `SECURITY.md`.
- Examples and README-linked documentation, including the upgrade guide and ADR.

Install the archive with `effect@4.0.6` in a clean temporary consumer, check
`npm ls effect --all`, import root/provider/gateway/workflow/queue/SMTP entry
points, and send one message through `Mock`. This verifies dependency resolution
outside the repository.

## Publish separately

Release preparation does not publish, create a tag, or push changes. Review and
commit the qualified source before publishing the retained archive with npm
credentials authorized for the `@doeixd` scope:

```sh
npm publish ./doeixd-effect-email-0.3.0.tgz --access public
```

After publication, verify the registry version, repeat the clean consumer smoke
test against `@doeixd/effect-email@0.3.0`, and create the `v0.3.0` tag on the
release commit with the changelog entry.

Provider webhook signature helpers and concurrent-worker load tests remain
follow-up work. The default gateway and catcher deny access until authorization
hooks are supplied; consult the [operations guide](./operations.md).
