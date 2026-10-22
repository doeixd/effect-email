import { Effect, Function, Schema, SchemaIssue } from "effect"
import type { DeliveryId } from "./Ids"
import { DeliveryId as DeliveryIdSchema, EmailAddress } from "./Ids"
import { InvalidMessage } from "./EmailError"

const formatIssue = SchemaIssue.makeFormatterDefault()

const hasNoHeaderBreaks = Schema.makeFilter(
  (value: string) =>
    !/[\r\n\0]/.test(value) ||
    "must not contain carriage returns, line feeds, or NUL bytes"
)

const HeaderName = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) =>
        /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(value) ||
        "must be a valid RFC 5322 header name"
    )
  )
)
export type HeaderName = typeof HeaderName.Type

const HeaderValue = Schema.String.pipe(Schema.check(hasNoHeaderBreaks))
export type HeaderValue = typeof HeaderValue.Type

export const Header = Schema.Tuple([HeaderName, HeaderValue])
export type Header = typeof Header.Type

export const NormalizedAddress = Schema.Struct({
  address: EmailAddress,
  local: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String)
})
export type NormalizedAddress = typeof NormalizedAddress.Type

export const MailboxInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    address: Schema.String,
    name: Schema.optionalKey(Schema.String)
  })
])
export type MailboxInput = typeof MailboxInput.Type

const MailboxListInput = Schema.Union([
  MailboxInput,
  Schema.Array(MailboxInput)
])
export type MailboxListInput = typeof MailboxListInput.Type

export const AttachmentEncoding = Schema.Literals(["binary", "base64", "utf8"])
export type AttachmentEncoding = typeof AttachmentEncoding.Type

export const AttachmentSource = Schema.Union([
  Schema.TaggedStruct("content", {
    content: Schema.Uint8Array,
    encoding: Schema.optionalKey(AttachmentEncoding)
  }),
  Schema.TaggedStruct("path", {
    path: Schema.NonEmptyString
  }),
  Schema.TaggedStruct("url", {
    url: Schema.NonEmptyString
  })
])
export type AttachmentSource = typeof AttachmentSource.Type

export const AttachmentDisposition = Schema.Literals(["attachment", "inline"])
export type AttachmentDisposition = typeof AttachmentDisposition.Type

export const Attachment = Schema.Struct({
  filename: Schema.NonEmptyString.pipe(Schema.check(hasNoHeaderBreaks)),
  contentType: Schema.optionalKey(
    Schema.NonEmptyString.pipe(Schema.check(hasNoHeaderBreaks))
  ),
  contentId: Schema.optionalKey(
    Schema.NonEmptyString.pipe(Schema.check(hasNoHeaderBreaks))
  ),
  disposition: Schema.optionalKey(AttachmentDisposition),
  source: AttachmentSource
})
export type Attachment = typeof Attachment.Type

export const RenderedContent = Schema.TaggedStruct("rendered", {
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String)
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (content: { readonly text?: string; readonly html?: string }) =>
        content.text !== undefined || content.html !== undefined ||
        "a rendered message requires text, html, or both"
    )
  )
)
export type RenderedContent = typeof RenderedContent.Type

export const TemplateContent = Schema.TaggedStruct("template", {
  id: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.String),
  props: Schema.optionalKey(Schema.Json)
})
export type TemplateContent = typeof TemplateContent.Type

export const ProviderTemplateContent = Schema.TaggedStruct(
  "provider-template",
  {
    id: Schema.NonEmptyString,
    variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
  }
)
export type ProviderTemplateContent = typeof ProviderTemplateContent.Type

export const RawMimeContent = Schema.TaggedStruct("raw", {
  mime: Schema.Uint8Array
})
export type RawMimeContent = typeof RawMimeContent.Type

export const MessageContent = Schema.Union([
  RenderedContent,
  TemplateContent,
  ProviderTemplateContent,
  RawMimeContent
])
export type MessageContent = typeof MessageContent.Type

export const MessageInputSchema = Schema.Struct({
  from: Schema.optionalKey(MailboxInput),
  to: MailboxListInput,
  cc: Schema.optionalKey(MailboxListInput),
  bcc: Schema.optionalKey(MailboxListInput),
  replyTo: Schema.optionalKey(MailboxListInput),
  subject: Schema.String.pipe(Schema.check(hasNoHeaderBreaks)),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  template: Schema.optionalKey(
    Schema.Struct({
      id: Schema.NonEmptyString,
      version: Schema.optionalKey(Schema.String),
      props: Schema.optionalKey(Schema.Json)
    })
  ),
  providerTemplate: Schema.optionalKey(
    Schema.Struct({
      id: Schema.NonEmptyString,
      variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
    })
  ),
  rawMime: Schema.optionalKey(Schema.Uint8Array),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  headers: Schema.optionalKey(Schema.Array(Header)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  deliveryId: Schema.optionalKey(DeliveryIdSchema)
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (input: {
        readonly text?: string
        readonly html?: string
        readonly template?: unknown
        readonly providerTemplate?: unknown
        readonly rawMime?: Uint8Array
      }) => {
        const kinds = [
          input.text !== undefined || input.html !== undefined,
          input.template !== undefined,
          input.providerTemplate !== undefined,
          input.rawMime !== undefined
        ].filter(Boolean).length
        return kinds === 1 || "exactly one content form must be provided"
      }
    )
  )
)
export interface MessageInput {
  readonly from?: MailboxInput
  readonly to: MailboxInput | ReadonlyArray<MailboxInput>
  readonly cc?: MailboxInput | ReadonlyArray<MailboxInput>
  readonly bcc?: MailboxInput | ReadonlyArray<MailboxInput>
  readonly replyTo?: MailboxInput | ReadonlyArray<MailboxInput>
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly template?: {
    readonly id: string
    readonly version?: string
    readonly props?: Schema.Json
  }
  readonly providerTemplate?: {
    readonly id: string
    readonly variables?: Readonly<Record<string, Schema.Json>>
  }
  readonly rawMime?: Uint8Array
  readonly attachments?: ReadonlyArray<Attachment>
  readonly headers?: ReadonlyArray<Header>
  readonly tags?: ReadonlyArray<string>
  readonly deliveryId?: DeliveryId
}

export interface MessageDraft {
  readonly from?: NormalizedAddress
  readonly to: ReadonlyArray<NormalizedAddress>
  readonly cc: ReadonlyArray<NormalizedAddress>
  readonly bcc: ReadonlyArray<NormalizedAddress>
  readonly replyTo: ReadonlyArray<NormalizedAddress>
  readonly subject: string
  readonly content: MessageContent
  readonly attachments: ReadonlyArray<Attachment>
  readonly headers: ReadonlyArray<Header>
  readonly tags: ReadonlyArray<string>
  readonly deliveryId?: DeliveryId
}

export interface PreparedMessage extends MessageDraft {
  readonly from: NormalizedAddress
}

export type AddressParse =
  | { readonly _tag: "ok"; readonly value: NormalizedAddress }
  | { readonly _tag: "error"; readonly message: string }

const fail = (message: string): AddressParse => ({ _tag: "error", message })

const unquoteName = (name: string): string | undefined => {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
      ? trimmed.slice(1, -1).replace(/\\"/g, '"')
      : trimmed
  return unquoted.trim()
}

const parseSingleMailbox = (raw: string): AddressParse => {
  if (/[\r\n\0]/.test(raw)) {
    return fail("mailbox must not contain line breaks or NUL bytes")
  }

  let address = raw.trim()
  let name: string | undefined

  const named = /^(.*)<([^<>]*)>\s*$/.exec(address)
  if (named !== null) {
    name = unquoteName(named[1] ?? "")
    address = (named[2] ?? "").trim()
  }

  if (address.includes("<") || address.includes(">")) {
    return fail("mailbox contains unbalanced angle brackets")
  }

  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) {
    return fail("mailbox must contain a local part and a domain")
  }

  const local = address.slice(0, at).trim()
  const domainRaw = address.slice(at + 1).trim().toLowerCase()

  if (local.length === 0 || domainRaw.length === 0) {
    return fail("mailbox must contain a local part and a domain")
  }
  if (local.length > 64) {
    return fail("mailbox local part exceeds 64 characters")
  }
  if (local.includes("@")) {
    return fail("mailbox local part must not contain @")
  }
  if (local.includes(" ") && !/^".*"$/.test(local)) {
    return fail("mailbox local part contains unquoted whitespace")
  }

  const isIpLiteral =
    domainRaw.startsWith("[") && domainRaw.endsWith("]")
  if (!isIpLiteral) {
    if (domainRaw.length > 253) {
      return fail("mailbox domain exceeds 253 characters")
    }
    if (domainRaw.startsWith(".") || domainRaw.endsWith(".")) {
      return fail("mailbox domain must not start or end with a dot")
    }
    const labels = domainRaw.split(".")
    for (const label of labels) {
      if (
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      ) {
        return fail("mailbox domain contains an invalid label")
      }
    }
  }

  const addressValue = `${local}@${domainRaw}`
  if (addressValue.length > 254) {
    return fail("mailbox exceeds 254 characters")
  }

  return {
    _tag: "ok",
    value: Object.freeze(
      Schema.decodeUnknownSync(NormalizedAddress)({
        address: addressValue,
        local,
        domain: domainRaw,
        ...(name === undefined ? {} : { name })
      })
    )
  }
}

export const parseMailbox = (input: MailboxInput): AddressParse =>
  parseSingleMailbox(typeof input === "string" ? input : inputString(input))

export const normalizeMailbox = (input: MailboxInput): NormalizedAddress =>
  unwrapAddress(parseMailbox(input), "mailbox")

const inputString = (input: {
  readonly address: string
  readonly name?: string
}): string => {
  if (input.name === undefined) {
    return input.address
  }
  return `${input.name} <${input.address}>`
}

const normalizeMailboxList = (
  input: MailboxInput | ReadonlyArray<MailboxInput> | undefined
): ReadonlyArray<NormalizedAddress> => {
  if (input === undefined) {
    return []
  }
  const list: ReadonlyArray<MailboxInput> = Array.isArray(input)
    ? input
    : [input as MailboxInput]
  const seen = new Set<string>()
  const result: Array<NormalizedAddress> = []
  for (const item of list) {
    const parsed = parseMailbox(item)
    if (parsed._tag === "error") {
      throw new InvalidMessage({ message: parsed.message })
    }
    const key = parsed.value.address.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(parsed.value)
    }
  }
  return Object.freeze(result)
}

const normalizeHeaders = (
  headers: ReadonlyArray<Header> | undefined
): ReadonlyArray<Header> => {
  if (headers === undefined) {
    return []
  }
  const reserved = new Set([
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
    "content-transfer-encoding",
    "content-disposition",
    "return-path",
    "received"
  ])
  const result: Array<Header> = []
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (reserved.has(lower)) {
      throw new InvalidMessage({
        message: `header ${name} is managed by the message model`
      })
    }
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
      throw new InvalidMessage({ message: `invalid header name: ${name}` })
    }
    if (/[\r\n\0]/.test(value)) {
      throw new InvalidMessage({
        message: `header ${name} contains a line break or NUL byte`
      })
    }
    result.push(Object.freeze([lower, value] as const) as Header)
  }
  return Object.freeze(result)
}

const normalizeTags = (
  tags: ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
  if (tags === undefined) {
    return []
  }
  const seen = new Set<string>()
  const result: Array<string> = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag.length === 0) {
      throw new InvalidMessage({ message: "tags must not be empty" })
    }
    if (tag.length > 256) {
      throw new InvalidMessage({
        message: "tags must be 256 characters or fewer"
      })
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(tag)) {
      throw new InvalidMessage({
        message:
          "tags may contain only letters, digits, dots, underscores, and hyphens"
      })
    }
    if (!seen.has(tag)) {
      seen.add(tag)
      result.push(tag)
    }
  }
  return Object.freeze(result)
}

const normalizeAttachments = (
  attachments: ReadonlyArray<Attachment> | undefined
): ReadonlyArray<Attachment> => {
  if (attachments === undefined) {
    return []
  }
  return Object.freeze(
    attachments.map((attachment) =>
      Object.freeze({
        ...attachment,
        disposition: attachment.disposition ?? "attachment"
      })
    )
  )
}

const contentFromInput = (input: MessageInput): MessageContent => {
  if (input.rawMime !== undefined) {
    return Object.freeze({ _tag: "raw", mime: input.rawMime })
  }
  if (input.providerTemplate !== undefined) {
    return Object.freeze({
      _tag: "provider-template",
      id: input.providerTemplate.id,
      ...(input.providerTemplate.variables === undefined
        ? {}
        : { variables: input.providerTemplate.variables })
    })
  }
  if (input.template !== undefined) {
    return Object.freeze({
      _tag: "template",
      id: input.template.id,
      ...(input.template.version === undefined
        ? {}
        : { version: input.template.version }),
      ...(input.template.props === undefined
        ? {}
        : { props: input.template.props })
    })
  }
  return Object.freeze({
    _tag: "rendered",
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.html === undefined ? {} : { html: input.html })
  })
}

const toArray = (
  input: MailboxInput | ReadonlyArray<MailboxInput> | undefined
): ReadonlyArray<MailboxInput> =>
  input === undefined
    ? []
    : Array.isArray(input)
      ? input
      : [input as MailboxInput]

const draftFromInput = (input: MessageInput): MessageDraft => {
  const from =
    input.from === undefined
      ? undefined
      : unwrapAddress(parseMailbox(input.from), "from")

  return Object.freeze({
    ...(from === undefined ? {} : { from }),
    to: normalizeMailboxList(toArray(input.to)),
    cc: normalizeMailboxList(toArray(input.cc)),
    bcc: normalizeMailboxList(toArray(input.bcc)),
    replyTo: normalizeMailboxList(toArray(input.replyTo)),
    subject: input.subject,
    content: contentFromInput(input),
    attachments: normalizeAttachments(input.attachments),
    headers: normalizeHeaders(input.headers),
    tags: normalizeTags(input.tags),
    ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId })
  })
}

const unwrapAddress = (
  parsed: AddressParse,
  field: string
): NormalizedAddress => {
  if (parsed._tag === "error") {
    throw new InvalidMessage({ message: `invalid ${field}: ${parsed.message}` })
  }
  return parsed.value
}

export const isDraft = (
  input: MessageInput | MessageDraft
): input is MessageDraft => "content" in input

export const decode = (input: unknown): Effect.Effect<MessageDraft, InvalidMessage> =>
  Schema.decodeUnknownEffect(MessageInputSchema)(input).pipe(
    Effect.mapError(
      (issue) =>
        new InvalidMessage({
          message: "invalid message",
          issues: formatIssue(issue.issue)
        })
    ),
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => draftFromInput(decoded),
        catch: (cause) =>
          cause instanceof InvalidMessage
            ? cause
            : new InvalidMessage({
                message: "invalid message",
                issues: String(cause)
              })
      })
    )
  )

export const make = (input: MessageInput): MessageDraft =>
  draftFromInput(Schema.decodeUnknownSync(MessageInputSchema)(input))

export interface PrepareDefaults {
  readonly from?: MailboxInput
  readonly deliveryId?: DeliveryId
}

export const prepare = Effect.fn("Message.prepare")(function* (
  input: MessageInput | MessageDraft,
  defaults: PrepareDefaults = {}
): Effect.fn.Return<PreparedMessage, InvalidMessage> {
  const draft = isDraft(input) ? input : yield* decode(input)
  const from = yield* Effect.try({
    try: () =>
      draft.from ??
      (defaults.from === undefined
        ? undefined
        : unwrapAddress(parseMailbox(defaults.from), "default from")),
    catch: (cause) =>
      cause instanceof InvalidMessage
        ? cause
        : new InvalidMessage({ message: String(cause) })
  })

  if (from === undefined) {
    return yield* new InvalidMessage({
      message: "a sender address is required"
    })
  }

  const recipients =
    draft.to.length + draft.cc.length + draft.bcc.length
  if (recipients === 0) {
    return yield* new InvalidMessage({
      message: "at least one recipient is required"
    })
  }


  return Object.freeze({
    ...draft,
    from,
    deliveryId: draft.deliveryId ?? defaults.deliveryId
  })
})

export const setFrom = Function.dual<
  (from: MailboxInput) => (draft: MessageDraft) => MessageDraft,
  (draft: MessageDraft, from: MailboxInput) => MessageDraft
>(2, (draft, from) =>
  Object.freeze({
    ...draft,
    from: unwrapAddress(parseMailbox(from), "from")
  }))

export const withDeliveryId = Function.dual<(id: DeliveryId) => (draft: MessageDraft) => MessageDraft, (draft: MessageDraft, id: DeliveryId) => MessageDraft>(2, (draft, id) => Object.freeze({ ...draft, deliveryId: id }))

export const addTag = Function.dual<(tag: string) => (draft: MessageDraft) => MessageDraft, (draft: MessageDraft, tag: string) => MessageDraft>(2, (draft, tag) => {
  const normalized = tag.trim()
  if (normalized.length === 0) {
    throw new InvalidMessage({ message: "tags must not be empty" })
  }
  if (normalized.length > 256) {
    throw new InvalidMessage({
      message: "tags must be 256 characters or fewer"
    })
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new InvalidMessage({
      message:
        "tags may contain only letters, digits, dots, underscores, and hyphens"
    })
  }
  if (draft.tags.includes(normalized)) {
    return draft
  }
  return Object.freeze({ ...draft, tags: Object.freeze([...draft.tags, normalized]) })
})

export const addHeader = Function.dual<(header: Header) => (draft: MessageDraft) => MessageDraft, (draft: MessageDraft, header: Header) => MessageDraft>(2, (draft, header) =>
  Object.freeze({
    ...draft,
    headers: normalizeHeaders([...draft.headers, header])
  }))

export const addAttachment = Function.dual<(attachment: Attachment) => (draft: MessageDraft) => MessageDraft, (draft: MessageDraft, attachment: Attachment) => MessageDraft>(2, (draft, attachment) =>
  Object.freeze({
    ...draft,
    attachments: normalizeAttachments([...draft.attachments, attachment])
  }))

export const text = (value: string): RenderedContent =>
  Object.freeze({ _tag: "rendered", text: value })

export const html = (value: string): RenderedContent =>
  Object.freeze({ _tag: "rendered", html: value })

export const rendered = (parts: {
  readonly text?: string
  readonly html?: string
}): RenderedContent =>
  Object.freeze({
    _tag: "rendered",
    ...(parts.text === undefined ? {} : { text: parts.text }),
    ...(parts.html === undefined ? {} : { html: parts.html })
  })


