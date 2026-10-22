# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report privately to the repository maintainers with:

- affected package version,
- a minimal reproduction,
- impact and affected trust boundary,
- whether credentials or recipient data may be exposed,
- any suggested fix.

You should receive an acknowledgment before public disclosure.

## Supported versions

Security fixes target the latest published `0.1.x` release.

## Security defaults

- Gateway and Catcher deny non-health routes unless authorization is supplied.
- Provider event ingestion requires an explicit `verifyEvent` hook.
- HTTP request bodies are limited by `maxBodySize` (default 10 MiB).
- SMTP requires authentication by default when an authenticator is configured.
- SMTP AUTH is advertised only over TLS unless `allowInsecureAuth` is enabled.
- Provider credentials use `Redacted`; error causes are sanitized.
- Tags are restricted to header-safe tokens.
- Suppression is tenant-scoped and normalized.

## Deployment expectations

Applications are responsible for:

- authenticating callers at the gateway,
- verifying provider event signatures,
- tenant-aware authorization for status, cancel, redrive, and diagnostics,
- running the gateway behind a trusted ingress,
- protecting provider credentials and DKIM private keys,
- configuring retention and backup policies,
- keeping Node and dependencies patched.

Never expose `Catcher.handler` publicly.
