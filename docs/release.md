# Release checklist

Package: `@doeixd/effect-email`

## Preconditions

- Node 22 or newer.
- Bun installed for the repository scripts.
- Access to the `@doeixd` npm scope.
- `DATABASE_URL` pointing at PostgreSQL 16 for the integration test.

## Verify

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run smoke
bun examples/quick-start.ts
npm pack --dry-run
```

With PostgreSQL:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/effect_email bun run test
```

Confirm the packed tarball contains:

- `dist/` JavaScript and declaration files
- `migrations/0001` through `0004`
- `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `SECURITY.md`
- `examples/` including the Mock quick start, provider layers, routes, and Alchemy
- `docs/` including driver parity, runtime matrix, PostgreSQL, review, and improvement plans
- `src/` for source maps

## Publish

```sh
npm login
npm publish
```

`prepack` rebuilds `dist/` and runs the dist smoke test. `publishConfig.access`
is `public`.

## Post-publish

- Verify `npm view @doeixd/effect-email version`.
- Install the published package in a clean temporary project.
- Smoke-test root, provider, gateway, and workflow subpath imports.
- Tag the release and attach the changelog entry.

## Known release constraints

- The package name is scoped because the unscoped `effect-email` name is already
  used on npm.
- Provider webhook signature helpers and concurrent-worker load tests remain
  post-release hardening work. Concurrent PostgreSQL transaction isolation is
  covered by `test/Postgres.integration.test.ts`.
- The default gateway and catcher deny access unless authorization hooks are
  supplied.
