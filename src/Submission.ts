import { DateTime, Schema } from "effect"
import type {
  AttemptId,
  DeliveryId,
  Destination,
  DestinationId,
  GatewaySubmissionId,
  ProviderMessageId,
  RouteName
} from "./Ids"
import {
  AttemptId as AttemptIdSchema,
  DeliveryId as DeliveryIdSchema,
  Destination as DestinationSchema,
  DestinationId as DestinationIdSchema,
  GatewaySubmissionId as GatewaySubmissionIdSchema,
  ProviderMessageId as ProviderMessageIdSchema,
  RouteName as RouteNameSchema
} from "./Ids"
import { EmailError } from "./EmailError"
import { NormalizedAddress } from "./Message"

export const SubmissionReceipt = Schema.Struct({
  deliveryId: Schema.optionalKey(DeliveryIdSchema),
  provider: Schema.NonEmptyString,
  destinationId: DestinationIdSchema,
  providerMessageId: Schema.optionalKey(ProviderMessageIdSchema),
  acceptedAt: Schema.DateTimeUtc,
  route: Schema.optionalKey(RouteNameSchema),
  requestId: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
})
export type SubmissionReceipt = typeof SubmissionReceipt.Type

export const DeliveryState = Schema.Literals([
  "queued",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "unknown"
])
export type DeliveryState = typeof DeliveryState.Type

export const DeliveryStatus = Schema.Struct({
  providerMessageId: ProviderMessageIdSchema,
  provider: Schema.NonEmptyString,
  state: DeliveryState,
  at: Schema.optionalKey(Schema.DateTimeUtc)
})
export type DeliveryStatus = typeof DeliveryStatus.Type

export const AcceptedOutcome = Schema.TaggedStruct("accepted", {
  index: Schema.Int,
  receipt: SubmissionReceipt
})
export type AcceptedOutcome = typeof AcceptedOutcome.Type

export const RejectedOutcome = Schema.TaggedStruct("rejected", {
  index: Schema.Int,
  error: EmailError
})
export type RejectedOutcome = typeof RejectedOutcome.Type

export const UncertainOutcome = Schema.TaggedStruct("uncertain", {
  index: Schema.Int,
  error: EmailError
})
export type UncertainOutcome = typeof UncertainOutcome.Type

export const InvalidOutcome = Schema.TaggedStruct("invalid", {
  index: Schema.Int,
  error: EmailError
})
export type InvalidOutcome = typeof InvalidOutcome.Type

export const MessageOutcome = Schema.Union([
  AcceptedOutcome,
  RejectedOutcome,
  UncertainOutcome,
  InvalidOutcome
])
export type MessageOutcome = typeof MessageOutcome.Type

export class BatchExecutionError extends Schema.TaggedError<BatchExecutionError>()(
  "BatchExecutionError",
  {
    message: Schema.String,
    partial: Schema.optionalKey(Schema.Array(MessageOutcome)),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const AdmissionReceipt = Schema.Struct({
  gatewaySubmissionId: GatewaySubmissionIdSchema,
  deliveryId: DeliveryIdSchema,
  acceptedAt: Schema.DateTimeUtc,
  route: Schema.optionalKey(RouteNameSchema),
  destinationId: Schema.optionalKey(DestinationIdSchema)
})
export type AdmissionReceipt = typeof AdmissionReceipt.Type

export const AttemptIdentity = Schema.Struct({
  deliveryId: DeliveryIdSchema,
  attemptId: AttemptIdSchema,
  dispatchGeneration: Schema.Int,
  destinationId: DestinationIdSchema,
  submissionKey: Schema.String
})
export type AttemptIdentity = typeof AttemptIdentity.Type

export const BlobReference = Schema.Struct({
  key: Schema.NonEmptyString,
  size: Schema.Number,
  contentType: Schema.optionalKey(Schema.String),
  sha256: Schema.optionalKey(Schema.String)
})
export type BlobReference = typeof BlobReference.Type

export const RawSubmittedMail = Schema.Struct({
  envelope: Schema.Struct({
    mailFrom: Schema.NullOr(NormalizedAddress),
    rcptTo: Schema.NonEmptyArray(NormalizedAddress)
  }),
  rawMessage: BlobReference
})
export type RawSubmittedMail = typeof RawSubmittedMail.Type

export interface PreparedEnvelope {
  readonly message: import("./Message").PreparedMessage
  readonly deliveryId: DeliveryId
  readonly route: RouteName
  readonly destination: Destination
  readonly destinationId: DestinationId
  readonly providerIdempotencyKey?: string
}

export const makeReceipt = (input: {
  readonly provider: string
  readonly destinationId: DestinationId
  readonly deliveryId?: DeliveryId
  readonly providerMessageId?: ProviderMessageId
  readonly acceptedAt: DateTime.Utc
  readonly route?: RouteName
  readonly requestId?: string
  readonly metadata?: Readonly<Record<string, Schema.Json>>
}): SubmissionReceipt => input
