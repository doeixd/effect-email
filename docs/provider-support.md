# Provider support matrix

Evidence labels:

- **Contract-tested:** exercised against local fixtures or HTTP/SMTP doubles in
  this repository.
- **Sandbox-tested:** exercised against a real provider sandbox. None are
  currently claimed.
- **Production-reported:** reported from a production integration. None are
  currently claimed.

Adapter presence is not a claim of complete provider parity.

| Provider | Single | Native batch | Retrieve | Cancel | Evidence |
| --- | --- | --- | --- | --- | --- |
| Resend | yes | no | no | no | Contract-tested |
| Postmark | yes | yes | no | no | Contract-tested |
| SendGrid | yes | yes | no | no | Contract-tested |
| Mailjet | yes | yes | no | no | Contract-tested |
| MailerSend | yes | yes | yes | yes | Contract-tested |
| Brevo | yes | yes | scheduled only | scheduled only | Contract-tested |
| Mailgun | yes | yes | no | no | Contract-tested |
| SMTP | yes | no | no | no | Contract-tested |
| SMTP2GO | yes | no | no | no | Contract-tested |
| Mailtrap | yes | yes | no | no | Contract-tested |
| Mailpit | yes | no | local inbox | no | Contract-tested |
| Mailcrab | yes | no | local inbox | no | Contract-tested |
| Scaleway | yes | no | no | no | Contract-tested |
| SES | yes | no | no | no | Contract-tested |
| Cloudflare Email binding | yes | no | no | no | Contract-tested |
| Cloudflare Email Service binding | yes | no | no | no | Contract-tested |
| Cloudflare Email Service REST | yes | no | no | no | Contract-tested |
| ZeptoMail | yes | yes | no | no | Contract-tested |
| Azure Communication | yes | no | polling | no | Contract-tested |
| AhaSend | yes | no | no | no | Contract-tested |
| Loops | yes | no | no | no | Contract-tested |
| MailChannels | yes | yes | no | no | Contract-tested |
| Mailbreeze | yes | no | no | no | Contract-tested |
| Generic HTTP | yes | no | caller-owned | caller-owned | Contract-tested |
| Mock | yes | yes | no | no | Contract-tested |

## Contract coverage

Provider tests cover:

- payload and recipient mapping;
- authentication header construction;
- capability checks before dispatch;
- success, rejection, rate-limit, authentication, and malformed-response
  classification;
- idempotency key propagation where supported;
- native batch indexing and partial outcomes where supported;
- receipt routing for fallback and round-robin compositions.

## Known limitations

- No live-provider sandbox suite is enabled by default.
- Provider-hosted templates are destination-bound.
- Native batch idempotency semantics vary by provider; partial subset retry is
  opt-in through `partialBatchRetry`.
- SMTP is a submission gateway, not a full MTA.

Sandbox tests should be opt-in, secret-gated, and clearly separated from the
default deterministic suite.
