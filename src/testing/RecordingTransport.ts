import { DateTime, Effect, Ref, Schema } from "effect"
import type { Destination } from "../Ids"
import { makeDestination, providerMessageId } from "../Ids"
import type { TransportError } from "../EmailError"
import { DeliveryUncertain, ProviderRejected } from "../EmailError"
import type { PreparedEnvelope, SubmissionReceipt } from "../Submission"
import type {
  Transport,
  TransportCapabilities
} from "../EmailTransport"
import { makeCapabilities } from "../EmailTransport"

export interface RecordedAttempt {
  readonly envelope: PreparedEnvelope
  readonly outcome: "accepted" | "failed"
  readonly error?: TransportError
}

export type ScriptedOutcome =
  | {
      readonly type: "accepted"
      readonly providerMessageId?: string
      readonly metadata?: Readonly<Record<string, Schema.Json>>
    }
  | {
      readonly type: "rejected"
      readonly error?: TransportError
    }
  | {
      readonly type: "uncertain"
      readonly error?: TransportError
    }

export interface RecordingTransportOptions {
  readonly destination?: Partial<Destination>
  readonly capabilities?: Partial<TransportCapabilities>
  readonly script?: ReadonlyArray<ScriptedOutcome>
}

interface RecordingState {
  readonly attempts: ReadonlyArray<RecordedAttempt>
  readonly script: ReadonlyArray<ScriptedOutcome>
  readonly cursor: number
}

export interface RecordingTransportShape {
  readonly transport: Transport
  readonly attempts: Effect.Effect<ReadonlyArray<RecordedAttempt>>
  readonly script: Effect.Effect<ReadonlyArray<ScriptedOutcome>>
  readonly setScript: (
    script: ReadonlyArray<ScriptedOutcome>
  ) => Effect.Effect<void>
  readonly reset: Effect.Effect<void>
}

const destinationOf = (input?: Partial<Destination>): Destination =>
  makeDestination({
    provider: input?.provider ?? "recording",
    account: input?.account ?? "default"
  })

const defaultRejection = (): TransportError =>
  ProviderRejected.new({
    message: "scripted rejection",
    provider: "recording"
  })

const defaultUncertainty = (): TransportError =>
  DeliveryUncertain.new({
    message: "scripted uncertainty",
    provider: "recording"
  })

const receiptFor = (
  outcome: Extract<ScriptedOutcome, { readonly type: "accepted" }>,
  envelope: PreparedEnvelope,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: envelope.destination.provider,
  destinationId: envelope.destinationId,
  ...(outcome.providerMessageId === undefined
    ? {}
    : { providerMessageId: providerMessageId(outcome.providerMessageId) }),
  acceptedAt,
  route: envelope.route,
  ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata })
})

export const make = (
  options: RecordingTransportOptions = {}
): Effect.Effect<RecordingTransportShape> =>
  Effect.map(
    Ref.make<RecordingState>({
      attempts: [],
      script: options.script ?? [],
      cursor: 0
    }),
    (state) => {
      const destination = destinationOf(options.destination)
      const capabilities = makeCapabilities(options.capabilities)

      const send: Transport["send"] = Effect.fnUntraced(function* (
        envelope: PreparedEnvelope
      ) {
        const outcome = yield* Ref.modify(state, (current) => {
          const next =
            current.script[current.cursor] ??
            ({ type: "accepted" } as const)
          return [
            next,
            {
              ...current,
              cursor: current.cursor + 1
            }
          ]
        })

        if (outcome.type === "accepted") {
          const acceptedAt = yield* DateTime.now
          yield* Ref.update(state, (value) => ({
            ...value,
            attempts: [
              ...value.attempts,
              { envelope, outcome: "accepted" as const }
            ]
          }))
          return receiptFor(outcome, envelope, acceptedAt)
        }

        const error = outcome.error ?? (
          outcome.type === "rejected"
            ? defaultRejection()
            : defaultUncertainty()
        )
        yield* Ref.update(state, (value) => ({
          ...value,
          attempts: [
            ...value.attempts,
            { envelope, outcome: "failed" as const, error }
          ]
        }))
        return yield* error
      })

      return {
        transport: {
          destination,
          capabilities,
          send
        },
        attempts: Effect.map(Ref.get(state), (value) => value.attempts),
        script: Effect.map(Ref.get(state), (value) => value.script),
        setScript: (script) =>
          Ref.set(state, { attempts: [], script, cursor: 0 }),
        reset: Ref.set(state, { attempts: [], script: [], cursor: 0 })
      }
    }
  )

