import { Context, DateTime, Effect, Layer, Option, Ref } from "effect"
import type {
  Destination,
  ProviderMessageId
} from "../Ids"
import { destinationId, makeDestination, providerMessageId } from "../Ids"
import type { PreparedMessage } from "../Message"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  certaintyOf,
  ProviderRejected,
  RateLimited,
  TransportUnavailable
} from "../EmailError"
import type {
  MessageOutcome,
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import type {
  NativeBatchTransport,
  Transport,
  TransportCapabilities
} from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"

export type MockFailureCode =
  | "NETWORK"
  | "AUTH"
  | "RATE_LIMIT"
  | "PROVIDER"

export interface MockFailure {
  readonly code?: MockFailureCode
  readonly message?: string
}

export interface MockOptions {
  readonly fail?: boolean | MockFailure
  readonly failWhen?: (
    message: PreparedMessage,
    index: number
  ) => boolean
  readonly latencyMs?: number
  readonly account?: string
}

export interface MockInbox {
  readonly messages: Effect.Effect<ReadonlyArray<PreparedEnvelope>>
  readonly find: (
    address: string
  ) => Effect.Effect<ReadonlyArray<PreparedEnvelope>>
  readonly last: Effect.Effect<Option.Option<PreparedEnvelope>>
  readonly clear: Effect.Effect<void>
}

export interface MockClient {
  readonly transport: NativeBatchTransport
  readonly inbox: MockInbox
}

export class Client extends Context.Service<Client, MockClient>()(
  "@effect-email/providers/Mock/Client"
) {}

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: true,
  attachments: true,
  remoteAttachments: true,
  rawMime: true,
  tags: true,
  localTemplates: true,
  providerTemplates: true,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

interface MockState {
  readonly messages: ReadonlyArray<PreparedEnvelope>
  readonly seen: number
  readonly sequence: number
}

const failureFor = (failure: MockFailure | true): TransportError => {
  const spec = typeof failure === "object" ? failure : {}
  const common = {
    message: spec.message ?? "mock provider configured to fail",
    provider: "mock"
  }
  switch (spec.code) {
    case "NETWORK":
      return new TransportUnavailable({ ...common, retryable: true })
    case "AUTH":
      return new AuthenticationFailed(common)
    case "RATE_LIMIT":
      return new RateLimited({ ...common, retryable: true })
    case "PROVIDER":
    case undefined:
      return new ProviderRejected(common)
  }
}

const receiptFor = (
  envelope: PreparedEnvelope,
  destinationIdValue: ReturnType<typeof destinationId>,
  id: ProviderMessageId,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "mock",
  destinationId: destinationIdValue,
  providerMessageId: id,
  acceptedAt,
  route: envelope.route
})

export const makeClient = (
  options: MockOptions = {}
): Effect.Effect<MockClient> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<MockState>({
      messages: [],
      seen: 0,
      sequence: 0
    })
    const destination = makeDestination({
      provider: "mock",
      account: options.account ?? "default"
    })
    const resolvedDestinationId = destinationId(destination)

    const attempt = Effect.fn("Mock.send")(function* (
      envelope: PreparedEnvelope
    ): Effect.fn.Return<SubmissionReceipt, TransportError> {
      if (options.latencyMs !== undefined && options.latencyMs > 0) {
        yield* Effect.sleep(options.latencyMs)
      }
      const seen = yield* Ref.modify(state, (current) => [
        current.seen,
        { ...current, seen: current.seen + 1 }
      ])
      const configuredFailure: MockFailure | true | undefined =
        options.fail === true
          ? true
          : typeof options.fail === "object"
            ? options.fail
            : undefined
      const failed =
        configuredFailure !== undefined ||
        options.failWhen?.(envelope.message, seen) === true
      if (failed) {
        return yield* failureFor(configuredFailure ?? true)
      }
      const acceptedAt = yield* DateTime.now
      const sequence = yield* Ref.modify(state, (current) => {
        const next = current.sequence + 1
        return [
          next,
          {
            ...current,
            sequence: next,
            messages: [...current.messages, envelope]
          }
        ]
      })
      return receiptFor(
        envelope,
        resolvedDestinationId,
        providerMessageId(`mock_${sequence}`),
        acceptedAt
      )
    })

    const send: Transport["send"] = attempt

    const sendBatch: NativeBatchTransport["sendBatch"] = Effect.fn(
      "Mock.sendBatch"
    )(function* (
      envelopes: ReadonlyArray<PreparedEnvelope>
    ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, TransportError> {
      const outcomes: Array<MessageOutcome> = []
      for (const [index, envelope] of envelopes.entries()) {
        const result = yield* Effect.result(attempt(envelope))
        outcomes.push(
          result._tag === "Success"
            ? { _tag: "accepted", index, receipt: result.success }
            : certaintyOf(result.failure) === "unknown"
              ? { _tag: "uncertain", index, error: result.failure }
              : { _tag: "rejected", index, error: result.failure }
        )
      }
      return outcomes
    })

    const transport: NativeBatchTransport = {
      destination,
      capabilities: capabilities as NativeBatchTransport["capabilities"],
      send,
      sendBatch
    }

    const messages = Effect.map(Ref.get(state), (current) => current.messages)
    const inbox: MockInbox = {
      messages,
      find: (address) =>
        Effect.map(messages, (list) => {
          const target = address.toLowerCase()
          return list.filter((envelope) =>
            [
              ...envelope.message.to,
              ...envelope.message.cc,
              ...envelope.message.bcc
            ].some(
              (recipient) =>
                recipient.address.toLowerCase() === target
            )
          )
        }),
      last: Effect.map(messages, (list) =>
        Option.fromNullishOr(list.at(-1))
      ),
      clear: Ref.update(state, (current) => ({
        ...current,
        messages: []
      }))
    }

    return { transport, inbox }
  })

export const make = (
  options: MockOptions = {}
): Effect.Effect<Transport> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MockOptions = {}
): Layer.Layer<Client> => Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MockOptions = {}
): Layer.Layer<EmailTransport> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerWithClient = (
  options: MockOptions = {}
): Layer.Layer<EmailTransport | Client> =>
  layerTransportFromClient.pipe(Layer.provideMerge(layerClient(options)))

export const destinationFor = (account = "default"): Destination =>
  makeDestination({ provider: "mock", account })
