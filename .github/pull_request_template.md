## Summary

Describe the behavior change and the problem it solves.

## Verification

- [ ] `bun run check`
- [ ] `bun run smoke`
- [ ] PostgreSQL integration when schema or transaction behavior changed

## Security and compatibility

- [ ] No credentials, recipient data, or provider headers are logged.
- [ ] Gateway/Catcher authorization and event verification defaults remain safe.
- [ ] Public API changes and migration steps are documented.
- [ ] README, provider parity, runtime matrix, or migrations were updated when
      behavior changed.

## Test evidence

Include regression tests or command output.
