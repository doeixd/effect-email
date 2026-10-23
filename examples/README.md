# Examples

- `quick-start.ts` uses the in-memory Mock provider. No credentials or network
  access required:

  ```sh
  bun examples/quick-start.ts
  ```

- `provider-layer.ts` builds a provider client layer and reuses its transport:
  `bun examples/provider-layer.ts`.

- `routes.ts` sends through two Mock transports using `TransportRegistry`:
  `bun examples/routes.ts`.

- `postgres-service.ts` assembles the durable service shape with PostgreSQL,
  admission, worker, publisher, reconciler, and scoped shutdown. It requires
  `DATABASE_URL`:

  ```sh
  DATABASE_URL=postgres://user:pass@localhost:5432/effect_email \
    bun examples/postgres-service.ts
  ```
- `alchemy/` deploys a Cloudflare Worker with alchemy.run and a Cloudflare
  `send_email` binding. See [`alchemy/README.md`](./alchemy/README.md).

- `resend.ts` sends through Resend. It requires `RESEND_API_KEY`:

  ```sh
  RESEND_API_KEY=re_... bun examples/resend.ts
  ```
