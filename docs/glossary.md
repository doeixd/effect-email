# Delivery glossary

- **Prepare:** normalize addresses, validate content, render templates, and
  derive provider requirements.
- **Admit:** authorize a submission and durably commit a delivery intent.
- **Attempt:** one claimed provider submission for a delivery generation.
- **Accepted:** the provider accepted responsibility for submission. This is not
  recipient delivery.
- **Delivered:** a verified provider event says the recipient received the
  message.
- **Uncertain:** submission may have occurred, but the outcome is unknown.
  Automatic retry and fallback are disabled.
- **Retry:** another attempt through the same destination, subject to the retry
  policy and attempt budget.
- **Redrive:** an explicit operator action under a new dispatch generation.
  Active attempts reject redrive; reconcile first. Uncertain redrive requires
  duplicate-risk acknowledgment.
- **Cancel:** request that future dispatch stop. The outcome is
  `canceled-before-dispatch`, `cancellation-requested`, or `already-submitted`.
- **Receipt:** provider acceptance metadata, including destination and provider
  message ID when available.
- **Reconcile:** resolve stale or uncertain work through provider events,
  provider lookup, or explicit operator action.
