import { Effect } from "effect"
import type { RouteName } from "./Ids"
import { destinationId } from "./Ids"
import type { Transport } from "./EmailTransport"
import type { PreparedMessage } from "./Message"
import { checkCapabilities } from "./Capabilities"
import { UnsupportedCapability } from "./EmailError"

export interface MessageRequirements {
  readonly rawMime: boolean
  readonly localTemplates: boolean
  readonly providerTemplates: boolean
  readonly attachments: boolean
  readonly remoteAttachments: boolean
  readonly tags: boolean
  readonly recipients: number
}

export const requirementsOf = (
  message: PreparedMessage
): MessageRequirements => ({
  rawMime: message.content._tag === "raw",
  localTemplates: message.content._tag === "template",
  providerTemplates: message.content._tag === "provider-template",
  attachments: message.attachments.length > 0,
  remoteAttachments: message.attachments.some(
    (attachment) => attachment.source._tag === "url"
  ),
  tags: message.tags.length > 0,
  recipients: message.to.length + message.cc.length + message.bcc.length
})

export interface RouteCandidate {
  readonly route?: RouteName
  readonly transport: Transport
}

export interface RouteDiagnostic {
  readonly route?: RouteName
  readonly provider: string
  readonly destinationId: string
  readonly eligible: boolean
  readonly reasons: ReadonlyArray<UnsupportedCapability>
  readonly preferences: ReadonlyArray<"nativeBatch">
}

export interface RouteExplanation {
  readonly requirements: MessageRequirements
  readonly candidates: ReadonlyArray<RouteDiagnostic>
  readonly eligible: ReadonlyArray<RouteDiagnostic>
}

export interface ExplainOptions {
  readonly candidates: ReadonlyArray<RouteCandidate>
  readonly route?: RouteName
  readonly prefer?: ReadonlyArray<"nativeBatch">
}

export const explain = (
  message: PreparedMessage,
  options: ExplainOptions
): Effect.Effect<RouteExplanation> =>
  Effect.gen(function* () {
    const candidates: Array<RouteDiagnostic> = []
    for (const candidate of options.candidates) {
      const reasons: Array<UnsupportedCapability> = []
      if (
        options.route !== undefined &&
        candidate.route !== options.route
      ) {
        reasons.push(
          UnsupportedCapability.new({
            message: `route ${candidate.route ?? "default"} is outside the explicit route ${options.route}`,
            provider: candidate.transport.destination.provider,
            capability: "route"
          })
        )
      } else {
        const checked = yield* Effect.result(
          checkCapabilities(candidate.transport, message)
        )
        if (checked._tag === "Failure") {
          reasons.push(checked.failure)
        }
      }
      const preferences: Array<"nativeBatch"> = []
      if (
        reasons.length === 0 &&
        options.prefer?.includes("nativeBatch") === true &&
        candidate.transport.capabilities.nativeBatch
      ) {
        preferences.push("nativeBatch")
      }
      candidates.push({
        ...(candidate.route === undefined
          ? {}
          : { route: candidate.route }),
        provider: candidate.transport.destination.provider,
        destinationId: destinationId(candidate.transport.destination),
        eligible: reasons.length === 0,
        reasons,
        preferences
      })
    }
    return {
      requirements: requirementsOf(message),
      candidates,
      eligible: candidates.filter((candidate) => candidate.eligible)
    }
  })
