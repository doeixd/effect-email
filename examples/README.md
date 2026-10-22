# Examples

- `quick-start.ts` uses the in-memory Mock provider. No credentials or network
  access required:

  ```sh
  bun examples/quick-start.ts
  ```

- `alchemy/` deploys a Cloudflare Worker with alchemy.run and a Cloudflare
  `send_email` binding. See [`alchemy/README.md`](./alchemy/README.md).

- `resend.ts` sends through Resend. It requires `RESEND_API_KEY`:

  ```sh
  RESEND_API_KEY=re_... bun examples/resend.ts
  ```
