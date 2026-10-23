import { Schema, SchemaGetter } from "effect"

export const SubmissionCertainty = Schema.Literals([
  "not-submitted",
  "rejected",
  "unknown"
])
export type SubmissionCertainty = typeof SubmissionCertainty.Type

const sanitizeCause = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message
    }
  }
  if (cause !== null && typeof cause === "object") {
    const record = cause as Record<string, unknown>
    return {
      ...(typeof record._tag === "string"
        ? { _tag: record._tag }
        : {}),
      ...(typeof record.message === "string"
        ? { message: record.message }
        : {})
    }
  }
  return cause === undefined ? undefined : String(cause)
}

const SafeCause = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(sanitizeCause),
    encode: SchemaGetter.transform((cause) => cause)
  })
)

const transportFields = {
  message: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  destinationId: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Number),
  retryable: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(SafeCause)
}

export class AuthenticationFailed extends Schema.TaggedError<AuthenticationFailed>()(
  "AuthenticationFailed",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()(
  "ProviderRejected",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class TransportUnavailable extends Schema.TaggedError<TransportUnavailable>()(
  "TransportUnavailable",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class DeliveryUncertain extends Schema.TaggedError<DeliveryUncertain>()(
  "DeliveryUncertain",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class MalformedProviderResponse extends Schema.TaggedError<MalformedProviderResponse>()(
  "MalformedProviderResponse",
  transportFields
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class UnsupportedCapability extends Schema.TaggedError<UnsupportedCapability>()(
  "UnsupportedCapability",
  {
    ...transportFields,
    capability: Schema.String
  }
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  {
    ...transportFields,
    idempotencyKey: Schema.optionalKey(Schema.String)
  }
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class TemplateError extends Schema.TaggedError<TemplateError>()(
  "TemplateError",
  {
    message: Schema.String,
    templateId: Schema.String,
    version: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(SafeCause)
  }
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    message: Schema.String
  }
) {}
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "StoreUnavailable",
  {
    message: Schema.String,
    cause: Schema.optionalKey(SafeCause)
  }
) {
  static new(props: any) {
    return new this({ ...props, cause: sanitizeCause(props.cause) })
  }
}

export class SubmissionCanceled extends Schema.TaggedError<SubmissionCanceled>()(
  "SubmissionCanceled",
  {
    message: Schema.String,
    deliveryId: Schema.optionalKey(Schema.String)
  }
) {}

export class RecipientSuppressed extends Schema.TaggedError<RecipientSuppressed>()(
  "RecipientSuppressed",
  {
    message: Schema.String,
    recipients: Schema.Array(Schema.String),
    reason: Schema.optionalKey(Schema.String)
  }
) {}

export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()(
  "InvalidMessage",
  {
    message: Schema.String,
    issues: Schema.optionalKey(Schema.String)
  }
) {}

export const TransportError = Schema.Union([
  AuthenticationFailed,
  RateLimited,
  ProviderRejected,
  TransportUnavailable,
  DeliveryUncertain,
  MalformedProviderResponse,
  UnsupportedCapability,
  IdempotencyConflict
])
export type TransportError = typeof TransportError.Type

export const EmailError = Schema.Union([
  InvalidMessage,
  AuthenticationFailed,
  RateLimited,
  ProviderRejected,
  TransportUnavailable,
  DeliveryUncertain,
  MalformedProviderResponse,
  UnsupportedCapability,
  IdempotencyConflict,
  TemplateError,
  ConfigurationError,
  StoreUnavailable,
  RecipientSuppressed,
  SubmissionCanceled
])
export type EmailError = typeof EmailError.Type

export const certaintyOf = (error: EmailError): SubmissionCertainty => {
  switch (error._tag) {
    case "DeliveryUncertain":
    case "MalformedProviderResponse":
      return "unknown"
    case "ProviderRejected":
    case "AuthenticationFailed":
    case "IdempotencyConflict":
      return "rejected"
    case "InvalidMessage":
    case "RateLimited":
    case "TransportUnavailable":
    case "UnsupportedCapability":
    case "TemplateError":
    case "ConfigurationError":
    case "StoreUnavailable":
    case "RecipientSuppressed":
    case "SubmissionCanceled":
      return "not-submitted"
  }
}

export const isRetryable = (error: EmailError): boolean => {
  switch (error._tag) {
    case "RateLimited":
    case "TransportUnavailable":
      return true
    case "ProviderRejected":
      return error.retryable ?? (error.status !== undefined && error.status >= 500)
    case "DeliveryUncertain":
    case "AuthenticationFailed":
    case "UnsupportedCapability":
    case "IdempotencyConflict":
    case "InvalidMessage":
    case "MalformedProviderResponse":
    case "TemplateError":
    case "ConfigurationError":
    case "StoreUnavailable":
    case "RecipientSuppressed":
    case "SubmissionCanceled":
      return false
  }
}
