import { Effect, Schema } from "effect"
import { createHash, createSign } from "node:crypto"

export class DkimSigningError extends Schema.TaggedError<DkimSigningError>()(
  "DkimSigningError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface DkimOptions {
  readonly domain: string
  readonly selector: string
  readonly privateKey: string
  readonly headers?: ReadonlyArray<string>
  readonly timestamp?: number
  readonly expiresInSeconds?: number
}

const CRLF = "\r\n"
const trimWsp = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/g, "")

const DEFAULT_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "reply-to",
  "mime-version",
  "content-type"
]

interface ParsedHeader {
  readonly name: string
  readonly value: string
}

const parseHeaders = (mime: string): {
  readonly headers: ReadonlyArray<ParsedHeader>
  readonly body: string
} => {
  const separator = mime.indexOf(CRLF + CRLF)
  const headerText = separator < 0 ? mime : mime.slice(0, separator)
  const body = separator < 0 ? "" : mime.slice(separator + 4)
  const lines = headerText.split(CRLF)
  const headers: Array<ParsedHeader> = []
  let current: { name: string; value: string } | undefined
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (current !== undefined) {
        current = {
          ...current,
          value: current.value + " " + trimWsp(line)
        }
      }
      continue
    }
    const colon = line.indexOf(":")
    if (colon < 0) continue
    if (current !== undefined) headers.push(current)
    current = {
      name: line.slice(0, colon).trim(),
      value: trimWsp(line.slice(colon + 1))
    }
  }
  if (current !== undefined) headers.push(current)
  return { headers, body }
}

const canonicalHeader = (name: string, value: string): string =>
  `${name.trim().toLowerCase()}:${trimWsp(value
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " "))}`

const canonicalBody = (body: string): string => {
  const normalized = body.replace(/\r?\n/g, CRLF)
  const lines = normalized.split(CRLF).map((line) =>
    line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "")
  )
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  const value = lines.join(CRLF)
  return value.length === 0 ? "" : value + CRLF
}

export const sign = (
  mime: Uint8Array,
  options: DkimOptions
): Effect.Effect<Uint8Array, DkimSigningError> =>
  Effect.try({
    try: () => {
      // Canonicalization operates on octets; decoding arbitrary MIME as UTF-8
      // would replace non-UTF-8 bytes and change the message being signed.
      const text = Buffer.from(mime).toString("latin1")
      const parsed = parseHeaders(text)
      const names = (options.headers ?? DEFAULT_HEADERS).map((name) =>
        name.toLowerCase()
      )
      if (!/^[A-Za-z0-9.-]+$/.test(options.domain) ||
        !/^[A-Za-z0-9._-]+$/.test(options.selector)) {
        throw new Error("invalid DKIM domain or selector")
      }
      const used = new Set<number>()
      const selected: Array<ParsedHeader> = []
      for (const name of names) {
        for (let index = parsed.headers.length - 1; index >= 0; index--) {
          const header = parsed.headers[index]!
          if (!used.has(index) && header.name.toLowerCase() === name) {
            used.add(index)
            selected.push(header)
            break
          }
        }
      }
      if (!selected.some((header) => header.name.toLowerCase() === "from")) {
        throw new Error("DKIM signatures must sign the From header")
      }
      const bodyHash = createHash("sha256")
        .update(canonicalBody(parsed.body), "latin1")
        .digest("base64")
      const timestamp =
        options.timestamp ?? Math.floor(Date.now() / 1000)
      const signatureHeaderBase = [
        "v=1",
        "a=rsa-sha256",
        "c=relaxed/relaxed",
        `d=${options.domain}`,
        `s=${options.selector}`,
        `t=${timestamp}`,
        ...(options.expiresInSeconds === undefined
          ? []
          : [`x=${timestamp + options.expiresInSeconds}`]),
        `h=${selected
          .map((header) => header.name.toLowerCase())
          .join(":")}`,
        `bh=${bodyHash}`,
        "b="
      ].join("; ")
      const signingInput =
        selected
          .map(
            (header) =>
              canonicalHeader(header.name, header.value) + CRLF
          )
          .join("") +
        canonicalHeader("DKIM-Signature", signatureHeaderBase)
      const signature = createSign("RSA-SHA256")
        .update(signingInput, "latin1")
        .sign(options.privateKey, "base64")
      const header = `DKIM-Signature: ${signatureHeaderBase}${signature}${CRLF}`
      return new Uint8Array(Buffer.concat([Buffer.from(header, "ascii"), mime]))
    },
    catch: (cause) =>
      new DkimSigningError({
        message: "DKIM signing failed",
        cause
      })
  })
