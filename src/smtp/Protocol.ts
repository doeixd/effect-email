import { Schema } from "effect"

export interface SmtpReply {
  readonly code: number
  readonly lines: ReadonlyArray<string>
}

export const greeting: SmtpReply = {
  code: 220,
  lines: ["effect-email ESMTP"]
}

export const encodeReply = (reply: SmtpReply): Uint8Array => {
  const lines = reply.lines.length === 0 ? [""] : reply.lines
  return new TextEncoder().encode(
    lines
      .map(
        (line, index) =>
          `${reply.code}${index === lines.length - 1 ? " " : "-"}${line}\r\n`
      )
      .join("")
  )
}

const CRLF = Uint8Array.from([13, 10])
const DATA_TERMINATOR = Uint8Array.from([13, 10, 46, 13, 10])

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const result = new Uint8Array(left.length + right.length)
  result.set(left, 0)
  result.set(right, left.length)
  return result
}

const indexOf = (
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0
): number => {
  if (needle.length === 0) return from
  const last = haystack.length - needle.length
  outer: for (let index = Math.max(0, from); index <= last; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer
      }
    }
    return index
  }
  return -1
}

export interface LineFrame {
  readonly buffer: Uint8Array
  readonly discarding: boolean
}

export const emptyLineFrame: LineFrame = {
  buffer: new Uint8Array(),
  discarding: false
}

export interface LineFrameResult {
  readonly frame: LineFrame
  readonly lines: ReadonlyArray<string>
  readonly overflow: boolean
}

export const pushLineFrame = (
  frame: LineFrame,
  chunk: Uint8Array,
  maxLineBytes = 512
): LineFrameResult => {
  let buffer = concat(frame.buffer, chunk)
  let discarding = frame.discarding
  const lines: Array<string> = []
  let overflow = false

  while (true) {
    const index = indexOf(buffer, CRLF)
    if (index < 0) {
      if (discarding) {
        buffer = buffer.length > 0 && buffer[buffer.length - 1] === 13
          ? buffer.slice(-1)
          : new Uint8Array()
      } else if (buffer.length > maxLineBytes) {
        overflow = true
        discarding = true
        buffer = buffer[buffer.length - 1] === 13
          ? buffer.slice(-1)
          : new Uint8Array()
      }
      break
    }
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + CRLF.length)
    if (discarding) {
      discarding = false
      continue
    }
    if (line.length > maxLineBytes) {
      overflow = true
      continue
    }
    lines.push(new TextDecoder().decode(line))
  }

  return {
    frame: { buffer, discarding },
    lines,
    overflow
  }
}

export interface LineReadResult {
  readonly frame: LineFrame
  readonly line?: Uint8Array
  readonly overflow: boolean
}

export const takeLine = (
  frame: LineFrame,
  chunk: Uint8Array,
  maxLineBytes = 512
): LineReadResult => {
  let buffer = concat(frame.buffer, chunk)
  let discarding = frame.discarding
  if (discarding) {
    const index = indexOf(buffer, CRLF)
    if (index < 0) {
      return {
        frame: {
          buffer: buffer.length > 0 && buffer[buffer.length - 1] === 13
            ? buffer.slice(-1)
            : new Uint8Array(),
          discarding: true
        },
        overflow: true
      }
    }
    buffer = buffer.slice(index + CRLF.length)
    discarding = false
    return {
      frame: { buffer, discarding },
      overflow: true
    }
  }
  const index = indexOf(buffer, CRLF)
  if (index < 0) {
    if (buffer.length > maxLineBytes) {
      return {
        frame: {
          buffer: buffer[buffer.length - 1] === 13
            ? buffer.slice(-1)
            : new Uint8Array(),
          discarding: true
        },
        overflow: true
      }
    }
    return {
      frame: { buffer, discarding: false },
      overflow: false
    }
  }
  const line = buffer.slice(0, index)
  const rest = buffer.slice(index + CRLF.length)
  if (line.length > maxLineBytes) {
    return {
      frame: { buffer: rest, discarding: false },
      overflow: true
    }
  }
  return {
    frame: { buffer: rest, discarding: false },
    line,
    overflow: false
  }
}

export interface DataDecoder {
  readonly buffer: Uint8Array
  readonly discarding: boolean
}

export const emptyDataDecoder: DataDecoder = {
  buffer: new Uint8Array(),
  discarding: false
}

export interface DataDecoderResult {
  readonly decoder: DataDecoder
  readonly complete: boolean
  readonly tooLarge: boolean
  readonly content?: Uint8Array
  readonly remainder?: Uint8Array
}

const unstuff = (content: Uint8Array): Uint8Array => {
  const chunks: Array<Uint8Array> = []
  let start = 0
  while (start <= content.length) {
    const index = indexOf(content, CRLF, start)
    const end = index < 0 ? content.length : index
    const line = content.slice(start, end)
    chunks.push(
      line.length >= 2 && line[0] === 46 && line[1] === 46
        ? line.slice(1)
        : line
    )
    if (index < 0) break
    chunks.push(CRLF)
    start = index + CRLF.length
  }
  return concatAll(chunks)
}

const concatAll = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export const pushData = (
  decoder: DataDecoder,
  chunk: Uint8Array,
  maxBytes?: number
): DataDecoderResult => {
  const buffer = concat(decoder.buffer, chunk)
  const terminator = indexOf(buffer, DATA_TERMINATOR)
  if (terminator < 0) {
    if (
      !decoder.discarding &&
      maxBytes !== undefined &&
      buffer.length > maxBytes
    ) {
      return {
        decoder: {
          buffer: buffer.slice(-DATA_TERMINATOR.length),
          discarding: true
        },
        complete: false,
        tooLarge: true
      }
    }
    return {
      decoder: { buffer, discarding: decoder.discarding },
      complete: false,
      tooLarge: decoder.discarding
    }
  }

  const raw = buffer.slice(0, terminator + CRLF.length)
  const remainder = buffer.slice(
    terminator + DATA_TERMINATOR.length
  )
  if (decoder.discarding) {
    return {
      decoder: emptyDataDecoder,
      complete: true,
      tooLarge: true,
      remainder
    }
  }
  if (maxBytes !== undefined && raw.length > maxBytes) {
    return {
      decoder: emptyDataDecoder,
      complete: true,
      tooLarge: true,
      remainder
    }
  }
  return {
    decoder: emptyDataDecoder,
    complete: true,
    tooLarge: false,
    content: unstuff(raw),
    remainder
  }
}

export type SmtpCommandName =
  | "EHLO"
  | "HELO"
  | "MAIL"
  | "RCPT"
  | "DATA"
  | "RSET"
  | "NOOP"
  | "AUTH"
  | "STARTTLS"
  | "QUIT"
  | "UNKNOWN"

export interface SmtpCommand {
  readonly name: SmtpCommandName
  readonly argument: string
}

export const parseCommand = (line: string): SmtpCommand => {
  const space = line.indexOf(" ")
  const name = (space < 0 ? line : line.slice(0, space)).toUpperCase()
  const argument = space < 0 ? "" : line.slice(space + 1)
  switch (name) {
    case "EHLO":
    case "HELO":
    case "MAIL":
    case "RCPT":
    case "DATA":
    case "AUTH":
    case "STARTTLS":
    case "RSET":
    case "NOOP":
    case "QUIT":
      return { name, argument }
    default:
      return { name: "UNKNOWN", argument }
  }
}

export interface SmtpPath {
  readonly address: string | null
  readonly parameters: ReadonlyArray<string>
}

export const parsePath = (
  argument: string,
  prefix: string
): SmtpPath | undefined => {
  const value = argument.trim()
  if (!value.toUpperCase().startsWith(prefix)) {
    return undefined
  }
  const rest = value.slice(prefix.length).trim()
  if (!rest.startsWith("<")) {
    return undefined
  }
  const close = rest.indexOf(">")
  if (close < 0) {
    return undefined
  }
  const address = rest.slice(1, close)
  if (address.length > 0 && !address.includes("@")) {
    return undefined
  }
  const parameters = rest
    .slice(close + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return {
    address: address.length === 0 ? null : address,
    parameters
  }
}

export type SmtpPhase = "command" | "data" | "closed"

export interface SmtpSessionState {
  readonly phase: SmtpPhase
  readonly helo?: string
  readonly authenticated: boolean
  readonly mailFrom?: string | null
  readonly recipients: ReadonlyArray<string>
}

export const initialSession: SmtpSessionState = {
  phase: "command",
  authenticated: false,
  recipients: []
}

export interface SmtpSubmission {
  readonly mailFrom: string | null
  readonly rcptTo: ReadonlyArray<string>
  readonly content: Uint8Array
}

export interface SmtpTransition {
  readonly state: SmtpSessionState
  readonly replies: ReadonlyArray<SmtpReply>
  readonly beginData?: boolean
  readonly close?: boolean
  readonly submission?: SmtpSubmission
}

const reply = (code: number, ...lines: Array<string>): SmtpReply => ({
  code,
  lines
})

const clearTransaction = (
  state: SmtpSessionState
): SmtpSessionState => ({
  ...state,
  phase: "command",
  mailFrom: undefined,
  recipients: []
})

export const transition = (
  state: SmtpSessionState,
  command: SmtpCommand
): SmtpTransition => {
  if (state.phase === "closed") {
    return { state, replies: [] }
  }
  switch (command.name) {
    case "EHLO":
    case "HELO": {
      const name = command.argument.trim()
      if (name.length === 0) {
        return {
          state,
          replies: [reply(501, "Syntax: EHLO hostname")]
        }
      }
      return {
        state: {
          ...clearTransaction(state),
          phase: "command",
          helo: name
        },
        replies: [
          command.name === "EHLO"
            ? reply(250, `Hello ${name}`)
            : reply(250, `Hello ${name}`)
        ]
      }
    }
    case "MAIL": {
      if (state.helo === undefined) {
        return {
          state,
          replies: [reply(503, "Send EHLO or HELO first")]
        }
      }
      if (state.phase !== "command") {
        return {
          state,
          replies: [reply(503, "Bad sequence of commands")]
        }
      }
      const path = parsePath(command.argument, "FROM:")
      if (path === undefined) {
        return {
          state,
          replies: [reply(501, "Syntax: MAIL FROM:<address>")]
        }
      }
      return {
        state: {
          ...state,
          mailFrom: path.address,
          recipients: []
        },
        replies: [reply(250, "Sender accepted")]
      }
    }
    case "RCPT": {
      if (state.mailFrom === undefined) {
        return {
          state,
          replies: [reply(503, "Send MAIL FROM first")]
        }
      }
      if (state.phase !== "command") {
        return {
          state,
          replies: [reply(503, "Bad sequence of commands")]
        }
      }
      const path = parsePath(command.argument, "TO:")
      if (path === undefined || path.address === null) {
        return {
          state,
          replies: [reply(501, "Syntax: RCPT TO:<address>")]
        }
      }
      return {
        state: {
          ...state,
          recipients: [...state.recipients, path.address]
        },
        replies: [reply(250, "Recipient accepted")]
      }
    }
    case "DATA": {
      if (
        state.mailFrom === undefined ||
        state.recipients.length === 0
      ) {
        return {
          state,
          replies: [reply(503, "Need MAIL FROM and RCPT TO")]
        }
      }
      return {
        state: { ...state, phase: "data" },
        replies: [
          reply(354, "End data with <CR><LF>.<CR><LF>")
        ],
        beginData: true
      }
    }
    case "RSET":
      return {
        state: clearTransaction(state),
        replies: [reply(250, "Transaction reset")]
      }
    case "NOOP":
      return { state, replies: [reply(250, "OK")] }
    case "AUTH":
      return {
        state,
        replies: [reply(502, "Authentication not available")]
      }
    case "STARTTLS":
      return {
        state,
        replies: [reply(502, "STARTTLS not available")]
      }
    case "QUIT":
      return {
        state: { ...state, phase: "closed" },
        replies: [reply(221, "Bye")],
        close: true
      }
    case "UNKNOWN":
      return {
        state,
        replies: [reply(500, "Command not recognized")]
      }
  }
}

export const completeData = (
  state: SmtpSessionState,
  content: Uint8Array
): SmtpTransition => {
  if (
    state.phase !== "data" ||
    state.mailFrom === undefined ||
    state.recipients.length === 0
  ) {
    return {
      state,
      replies: [reply(503, "Bad sequence of commands")]
    }
  }
  return {
    state: clearTransaction(state),
    replies: [reply(250, "Message accepted")],
    submission: {
      mailFrom: state.mailFrom,
      rcptTo: state.recipients,
      content
    }
  }
}

export const SmtpReplySchema = Schema.Struct({
  code: Schema.Int,
  lines: Schema.Array(Schema.String)
})
