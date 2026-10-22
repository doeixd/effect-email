import { Schema } from "effect"

export const DeliveryId = Schema.NonEmptyString.pipe(
  Schema.brand("DeliveryId")
)
export type DeliveryId = typeof DeliveryId.Type

export const ProviderMessageId = Schema.NonEmptyString.pipe(
  Schema.brand("ProviderMessageId")
)
export type ProviderMessageId = typeof ProviderMessageId.Type

export const OperationId = Schema.NonEmptyString.pipe(
  Schema.brand("OperationId")
)
export type OperationId = typeof OperationId.Type

export const AttemptId = Schema.NonEmptyString.pipe(
  Schema.brand("AttemptId")
)
export type AttemptId = typeof AttemptId.Type

export const RouteName = Schema.NonEmptyString.pipe(
  Schema.brand("RouteName")
)
export type RouteName = typeof RouteName.Type

export const TenantId = Schema.NonEmptyString.pipe(
  Schema.brand("TenantId")
)
export type TenantId = typeof TenantId.Type

export const GatewaySubmissionId = Schema.NonEmptyString.pipe(
  Schema.brand("GatewaySubmissionId")
)
export type GatewaySubmissionId = typeof GatewaySubmissionId.Type

export const EmailAddress = Schema.NonEmptyString.pipe(
  Schema.brand("EmailAddress")
)
export type EmailAddress = typeof EmailAddress.Type

export const DestinationId = Schema.NonEmptyString.pipe(
  Schema.brand("DestinationId")
)
export type DestinationId = typeof DestinationId.Type

export const Destination = Schema.Struct({
  provider: Schema.NonEmptyString,
  account: Schema.NonEmptyString
})
export type Destination = typeof Destination.Type

export const makeDestination = (input: {
  readonly provider: string
  readonly account: string
}): Destination =>
  Schema.decodeUnknownSync(Destination)(input)

export const destinationId = (destination: Destination): DestinationId =>
  Schema.decodeUnknownSync(DestinationId)(
    `${encodeURIComponent(destination.provider)}:${encodeURIComponent(
      destination.account
    )}`
  )

export const deliveryId = (value: string): DeliveryId =>
  Schema.decodeUnknownSync(DeliveryId)(value)

export const providerMessageId = (value: string): ProviderMessageId =>
  Schema.decodeUnknownSync(ProviderMessageId)(value)

export const attemptId = (value: string): AttemptId =>
  Schema.decodeUnknownSync(AttemptId)(value)

export const routeName = (value: string): RouteName =>
  Schema.decodeUnknownSync(RouteName)(value)

export const tenantId = (value: string): TenantId =>
  Schema.decodeUnknownSync(TenantId)(value)

export const gatewaySubmissionId = (value: string): GatewaySubmissionId =>
  Schema.decodeUnknownSync(GatewaySubmissionId)(value)

let counter = 0

export const newDeliveryId = (): DeliveryId => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) {
    return deliveryId(`dlv_${uuid}`)
  }
  counter += 1
  return deliveryId(`dlv_${Date.now().toString(36)}_${counter}`)
}

export const newGatewaySubmissionId = (): GatewaySubmissionId => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) {
    return gatewaySubmissionId(`sub_${uuid}`)
  }
  counter += 1
  return gatewaySubmissionId(`sub_${Date.now().toString(36)}_${counter}`)
}
