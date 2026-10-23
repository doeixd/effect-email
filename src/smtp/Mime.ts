import { Effect } from "effect"
import { Base64 } from "effect/encoding"
import { UnsupportedCapability } from "../EmailError"
import type {
  Attachment,
  NormalizedAddress,
  PreparedMessage
} from "../Message"

export interface MimeOptions {
  readonly date?: Date
  readonly messageId?: string
}

const CRLF = "\r\n"

const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding"
])

const isAscii = (value: string): boolean =>
  /^[\x20-\x7E]*$/.test(value)

const encodedWord = (value: string): string =>
  isAscii(value)
    ? value
    : `=?UTF-8?B?${Base64.encode(
        new TextEncoder().encode(value)
      )}?=`

const formatAddress = (address: NormalizedAddress): string => {
  if (address.name === undefined) {
    return address.address
  }
  const name = encodedWord(address.name)
  return isAscii(address.name) &&
    /[",<>@;:\\]/.test(address.name)
    ? `"${address.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}" <${address.address}>`
    : `${name} <${address.address}>`
}

const formatAddressList = (
  addresses: ReadonlyArray<NormalizedAddress>
): string => addresses.map(formatAddress).join(", ")

const wrapBase64 = (value: string): string => {
  const compact = value.replace(/[^A-Za-z0-9+/=]/g, "")
  const lines = compact.match(/.{1,76}/g)
  return lines === null ? "" : lines.join(CRLF)
}

const contentBase64 = (content: Uint8Array): string =>
  wrapBase64(Base64.encode(content))

const attachmentBase64 = (
  attachment: Attachment
): Effect.Effect<string, UnsupportedCapability> => {
  switch (attachment.source._tag) {
    case "content":
      return Effect.succeed(
        attachment.source.encoding === "base64"
          ? wrapBase64(new TextDecoder().decode(attachment.source.content))
          : contentBase64(attachment.source.content)
      )
    case "path":
      return Effect.fail(
        UnsupportedCapability.new({
          message:
            "SMTP MIME building cannot read attachments from local paths",
          provider: "smtp",
          capability: "attachments"
        })
      )
    case "url":
      return Effect.fail(
        UnsupportedCapability.new({
          message:
            "SMTP MIME building does not fetch remote attachment URLs",
          provider: "smtp",
          capability: "remote-attachments"
        })
      )
  }
}

const quotedFilename = (filename: string): string =>
  `"${filename.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`

const bodyPart = (
  message: PreparedMessage,
  boundary: string
): Effect.Effect<
  { readonly contentType: string; readonly body: string },
  UnsupportedCapability
> => {
  if (message.content._tag === "raw") {
    return Effect.succeed({
      contentType: "message/rfc822",
      body: new TextDecoder().decode(message.content.mime)
    })
  }
  if (message.content._tag === "template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "local template was not rendered before SMTP submission",
        provider: "smtp",
        capability: "content"
      })
    )
  }
  if (message.content._tag === "provider-template") {
    return Effect.fail(
      UnsupportedCapability.new({
        message: "SMTP does not support provider-hosted templates",
        provider: "smtp",
        capability: "provider-templates"
      })
    )
  }

  const text = message.content.text
  const html = message.content.html
  const textPart =
    text === undefined
      ? ""
      : [
          "--" + boundary + "_alt",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          contentBase64(new TextEncoder().encode(text))
        ].join(CRLF)
  const htmlPart =
    html === undefined
      ? ""
      : [
          "--" + boundary + "_alt",
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          contentBase64(new TextEncoder().encode(html))
        ].join(CRLF)

  if (text !== undefined && html !== undefined) {
    return Effect.succeed({
      contentType: `multipart/alternative; boundary="${boundary}_alt"`,
      body: [
        textPart,
        htmlPart,
        `--${boundary}_alt--`
      ].join(CRLF)
    })
  }
  if (text !== undefined) {
    return Effect.succeed({
      contentType: "text/plain; charset=UTF-8",
      body: contentBase64(new TextEncoder().encode(text))
    })
  }
  return Effect.succeed({
    contentType: "text/html; charset=UTF-8",
    body: contentBase64(new TextEncoder().encode(html ?? ""))
  })
}

export const buildMime = (
  message: PreparedMessage,
  options: MimeOptions = {}
): Effect.Effect<Uint8Array, UnsupportedCapability> =>
  Effect.gen(function* () {
    if (message.content._tag === "raw") {
      return message.content.mime
    }

    const deliveryId = String(message.deliveryId ?? "message")
    const boundary = `=_effect_email_${deliveryId.replace(
      /[^A-Za-z0-9]/g,
      ""
    )}`
    const body = yield* bodyPart(message, boundary)
    const attachmentParts = yield* Effect.forEach(
      message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const encoded = yield* attachmentBase64(attachment)
          return [
            `--${boundary}_mix`,
            `Content-Type: ${
              attachment.contentType ?? "application/octet-stream"
            }`,
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: ${
              attachment.disposition ?? "attachment"
            }; filename=${quotedFilename(attachment.filename)}`,
            ...(attachment.contentId === undefined
              ? []
              : [`Content-ID: <${attachment.contentId}>`]),
            "",
            encoded
          ].join(CRLF)
        })
    )

    const domain =
      message.from.address.split("@")[1] ?? "localhost"
    const messageId =
      options.messageId ?? `<${deliveryId}@${domain}>`
    const date = options.date ?? new Date()
    const headers: Array<string> = [
      `From: ${formatAddress(message.from)}`,
      `To: ${formatAddressList(message.to)}`
    ]
    if (message.cc.length > 0) {
      headers.push(`Cc: ${formatAddressList(message.cc)}`)
    }
    if (message.replyTo.length > 0) {
      headers.push(`Reply-To: ${formatAddressList(message.replyTo)}`)
    }
    headers.push(`Subject: ${encodedWord(message.subject)}`)
    headers.push(`Date: ${date.toUTCString()}`)
    headers.push(`Message-ID: ${messageId}`)
    headers.push("MIME-Version: 1.0")
    for (const [name, value] of message.headers) {
      if (!RESERVED_HEADERS.has(name.toLowerCase())) {
        headers.push(`${name}: ${isAscii(value) ? value : encodedWord(value)}`)
      }
    }

    if (attachmentParts.length === 0) {
      headers.push(`Content-Type: ${body.contentType}`)
      headers.push("Content-Transfer-Encoding: base64")
      return new TextEncoder().encode(
        headers.join(CRLF) + CRLF + CRLF + body.body + CRLF
      )
    }

    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}_mix"`)
    const parts = [
      `--${boundary}_mix`,
      `Content-Type: ${body.contentType}`,
      ...(body.contentType.startsWith("multipart/")
        ? []
        : ["Content-Transfer-Encoding: base64"]),
      "",
      body.body,
      ...attachmentParts,
      `--${boundary}_mix--`
    ]
    return new TextEncoder().encode(
      headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF) + CRLF
    )
  })
