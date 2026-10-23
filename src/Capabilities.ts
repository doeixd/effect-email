import { Effect } from "effect"
import type { Transport } from "./EmailTransport"
import { UnsupportedCapability } from "./EmailError"
import type { PreparedMessage } from "./Message"

export const checkCapabilities = (
  transport: Transport,
  message: PreparedMessage
): Effect.Effect<void, UnsupportedCapability> => {
  const capabilities = transport.capabilities
  const fail = (capability: string, detail: string) =>
    Effect.fail(
      UnsupportedCapability.new({
        message: `${transport.destination.provider} does not support ${detail}`,
        provider: transport.destination.provider,
        capability
      })
    )

  if (message.content._tag === "raw" && !capabilities.rawMime) {
    return fail("raw-mime", "raw MIME messages")
  }
  if (message.content._tag === "template" && !capabilities.localTemplates) {
    return fail("local-templates", "local templates")
  }
  if (
    message.content._tag === "provider-template" &&
    !capabilities.providerTemplates
  ) {
    return fail("provider-templates", "provider-hosted templates")
  }
  if (message.attachments.length > 0) {
    if (!capabilities.attachments) {
      return fail("attachments", "attachments")
    }
    if (
      message.attachments.some((attachment) => attachment.source._tag === "url") &&
      !capabilities.remoteAttachments
    ) {
      return fail("remote-attachments", "remote attachment URLs")
    }
  }
  if (message.tags.length > 0 && !capabilities.tags) {
    return fail("tags", "message tags")
  }
  const recipients =
    message.to.length + message.cc.length + message.bcc.length
  const maxRecipients = capabilities.maxRecipientsPerMessage
  if (maxRecipients !== undefined && recipients > maxRecipients) {
    return fail(
      "max-recipients",
      `more than ${maxRecipients} recipients per message`
    )
  }

  return Effect.void
}
