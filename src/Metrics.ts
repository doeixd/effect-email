import { Metric } from "effect"

export const admissions = Metric.counter(
  "effect_email_admissions_total",
  { incremental: true }
)

export const attempts = Metric.counter(
  "effect_email_attempts_total",
  { incremental: true }
)

export const accepted = Metric.counter(
  "effect_email_accepted_total",
  { incremental: true }
)

export const rejected = Metric.counter(
  "effect_email_rejected_total",
  { incremental: true }
)

export const uncertain = Metric.counter(
  "effect_email_uncertain_total",
  { incremental: true }
)

export const retries = Metric.counter(
  "effect_email_retries_total",
  { incremental: true }
)

export const failures = Metric.counter(
  "effect_email_failures_total",
  { incremental: true }
)
