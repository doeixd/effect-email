# Runtime matrix

The root entrypoint (`@doeixd/effect-email`) exports core contracts, the transport registry, delivery storage,
queue integration, templates, spool, gateway handlers, and the catcher. It does
not import providers, Node server bindings, or SMTP adapters.

## Module availability

| Capability | Node 22+ | Bun | Deno | Cloudflare Workers |
| --- | --- | --- | --- | --- |
| Core message/email/transport/registry APIs | yes | yes | yes | yes |
| HTTP providers | yes | yes | yes | yes |
| `persistence/RateLimiter` | yes | yes | yes | yes |
| `persistence/PersistedQueue` | yes | yes | yes | yes |
| Templates, spool, gateway handlers | yes | yes | yes | yes |
| Azure Communication provider | yes | yes | yes | yes |
| SES provider | yes | yes | no | no |
| SMTP client/provider | yes | yes | no | no |
| SMTP server/listener | yes | yes | no | no |
| Node HTTP server binding | yes | yes | no | no |
| Cloudflare Email bindings | no | no | no | yes |
| Cloudflare Email Service binding | no | no | no | yes |

## Notes

- SES uses `node:crypto`; use an HTTP provider on Workers.
- Azure Communication uses Web Crypto and does not require Node.
- Placeholder filesystem paths are not read by MIME/SMTP builders; pass bytes or
  remote URLs supported by the selected provider.
- SMTP TLS and STARTTLS require a runtime with TCP/TLS sockets. The server
  binding uses `@effect/platform-node`.
- The SMTP server is a submission gateway, not a full MTA. It does not provide
  BDAT/CHUNKING, SMTPUTF8, MX lookup, remote-delivery scheduling, or bounce
  generation.
- Cloudflare bindings are injected values; the package does not import
  `cloudflare:email` or Worker-only globals.
