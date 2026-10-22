# Contributing

Thanks for helping improve `@doeixd/effect-email`.

## Setup

```sh
bun install
bun run check
```

`bun run check` builds `dist/`, typechecks the repository, and runs the test
suite. The quick-start example runs without credentials:

```sh
bun examples/quick-start.ts
```

## Development workflow

1. Keep public APIs typed and documented.
2. Add a regression test for every behavior change.
3. Preserve the root entrypoint boundary: no providers, Node server bindings,
   or SMTP Node adapters in `src/index.ts`.
4. Treat provider capabilities as claims that must be backed by tests.
5. Do not log or serialize credentials. Use `Redacted` and sanitized errors.
6. Run `bun run check` before opening a pull request.

PostgreSQL integration is gated by `DATABASE_URL`:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/effect_email bun run test
```

## Pull requests

- Describe the behavior change and the failure mode it addresses.
- Include test evidence and any relevant provider documentation links.
- Call out breaking changes and migration steps.
- Keep unrelated refactors out of the same pull request.
- Update README, driver parity, runtime matrix, or migrations when behavior
  changes.

## Review and release

The repository includes a detailed review plan and findings log:

- `docs/review-plan.md`
- `docs/review-findings.md`
- `docs/release.md`

New work should not reintroduce an open Critical or High finding.
