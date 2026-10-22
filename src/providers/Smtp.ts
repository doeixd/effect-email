import {
  DateTime,
  Effect,
  Layer,
  Pool,
  Redacted,
  Scope
} from "effect"
import { Base64 } from "effect/encoding"
import * as Socket from "effect/socket/Socket"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls"
import type { Destination } from "../Ids"
import { destinationId, makeDestination } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  certaintyOf,
  DeliveryUncertain,
  MalformedProviderResponse,
  ProviderRejected,
  TransportUnavailable,
  UnsupportedCapability
} from "../EmailError"
import type { Transport, TransportCapabilities } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import type {
  PreparedEnvelope,
  SubmissionReceipt
} from "../Submission"
import * as Dkim from "../smtp/Dkim"
import { buildMime } from "../smtp/Mime"
import * as Smtp from "../smtp/Protocol"

export interface SmtpOptions {
  readonly host: string
  readonly port: number
  readonly secure?: boolean
  readonly startTls?: boolean
  readonly allowInsecureAuth?: boolean
  readonly auth?: {
    readonly username: string
    readonly password: Redacted.Redacted<string>
  }
  readonly tls?: TlsConnectionOptions
  readonly startTlsOptions?: Socket.TlsUpgradeOptions
  readonly helo?: string
  readonly account?: string
  readonly maxLineBytes?: number
  readonly maxReplyLines?: number
  readonly dkim?: Dkim.DkimOptions
}

export const capabilities: TransportCapabilities = makeCapabilities({
  nativeBatch: false,
  attachments: true,
  remoteAttachments: false,
  rawMime: true,
  tags: false,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const socketFailure = (
  message: string,
  cause: unknown,
  submitted: boolean
): TransportError =>
  submitted
    ? new DeliveryUncertain({ message, provider: "smtp", cause })
    : new TransportUnavailable({
        message,
        provider: "smtp",
        retryable: true,
        cause
      })

const dotStuff = (content: Uint8Array): Uint8Array => {
  const chunks: Array<Uint8Array> = []
  let lineStart = true
  let previous = 0
  for (const byte of content) {
    if (lineStart && byte === 46) {
      chunks.push(Uint8Array.of(46))
    }
    chunks.push(Uint8Array.of(byte))
    lineStart = previous === 13 && byte === 10
    previous = byte
  }
  return concat(chunks)
}

const endsWithCrlf = (content: Uint8Array): boolean =>
  content.length >= 2 &&
  content[content.length - 2] === 13 &&
  content[content.length - 1] === 10

const receiptFor = (
  envelope: PreparedEnvelope,
  destination: Destination,
  acceptedAt: DateTime.Utc
): SubmissionReceipt => ({
  deliveryId: envelope.deliveryId,
  provider: "smtp",
  destinationId: destinationId(destination),
  acceptedAt,
  route: envelope.route
})

interface SmtpSession {
  readonly send: (
    envelope: PreparedEnvelope
  ) => Effect.Effect<SubmissionReceipt, TransportError>
  readonly healthy: () => boolean
}

const connect = (
  options: SmtpOptions
): Effect.Effect<
  SmtpSession,
  TransportError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const destination = makeDestination({
      provider: "smtp",
      account: options.account ?? `${options.host}:${options.port}`
    })
    let submitted = false
    let healthy = true
    let frame = Smtp.emptyLineFrame
    const helo = options.helo ?? "localhost"
    const maxLineBytes =
      options.maxLineBytes !== undefined &&
      Number.isFinite(options.maxLineBytes) &&
      options.maxLineBytes >= 1
        ? Math.floor(options.maxLineBytes)
        : 4096
    const maxReplyLines =
      options.maxReplyLines !== undefined &&
      Number.isFinite(options.maxReplyLines) &&
      options.maxReplyLines >= 1
        ? Math.floor(options.maxReplyLines)
        : 100

    const socket = yield* (options.secure === true
      ? NodeSocket.makeTls({
          host: options.host,
          port: options.port,
          ...options.tls
        })
      : NodeSocket.makeNet({
          host: options.host,
          port: options.port
        })).pipe(
      Effect.mapError((cause) =>
        socketFailure("SMTP connection failed", cause, false)
      )
    )

    const reader = yield* socket.reader.pipe(
      Effect.mapError((cause) =>
        socketFailure("SMTP reader failed", cause, submitted)
      )
    )
    const writer = yield* socket.writer.pipe(
      Effect.mapError((cause) =>
        socketFailure("SMTP writer failed", cause, submitted)
      )
    )

    const write = (
      chunk: Uint8Array
    ): Effect.Effect<void, TransportError> =>
      writer.write(chunk).pipe(
        Effect.mapError((cause) =>
          socketFailure("SMTP write failed", cause, submitted)
        )
      )

    const readLine = (): Effect.Effect<string, TransportError> =>
      Effect.gen(function* () {
        while (true) {
          const read = Smtp.takeLine(
            frame,
            new Uint8Array(),
            maxLineBytes
          )
          frame = read.frame
          if (read.line !== undefined) {
            return new TextDecoder().decode(read.line)
          }
          if (read.overflow) {
            return yield* new MalformedProviderResponse({
              message: "SMTP server sent an overlong line",
              provider: "smtp"
            })
          }
          const chunks = yield* reader.pull.pipe(
            Effect.mapError((cause) =>
              socketFailure("SMTP read failed", cause, submitted)
            )
          )
          const bytes = concat(
            chunks.map((chunk) =>
              typeof chunk === "string"
                ? new TextEncoder().encode(chunk)
                : chunk
            )
          )
          frame = {
            buffer: concat([frame.buffer, bytes]),
            discarding: false
          }
        }
      })

    const readReply = (): Effect.Effect<
      Smtp.SmtpReply,
      TransportError
    > =>
      Effect.gen(function* () {
        const first = yield* readLine()
        const match = /^(\d{3})([ -])(.*)$/.exec(first)
        if (match === null) {
          return yield* new MalformedProviderResponse({
            message: "SMTP reply did not start with a status code",
            provider: "smtp"
          })
        }
        const code = Number(match[1])
        const lines = [match[3] ?? ""]
        let separator = match[2]
        while (separator === "-") {
          if (lines.length >= maxReplyLines) {
            return yield* new MalformedProviderResponse({
              message: `SMTP multiline reply exceeded ${maxReplyLines} lines`,
              provider: "smtp"
            })
          }
          const next = yield* readLine()
          const nextMatch = /^(\d{3})([ -])(.*)$/.exec(next)
          if (nextMatch === null || Number(nextMatch[1]) !== code) {
            return yield* new MalformedProviderResponse({
              message: "SMTP multiline reply was malformed",
              provider: "smtp"
            })
          }
          separator = nextMatch[2]
          lines.push(nextMatch[3] ?? "")
        }
        return { code, lines }
      })

    const command = (
      value: string
    ): Effect.Effect<Smtp.SmtpReply, TransportError> =>
      Effect.gen(function* () {
        yield* write(new TextEncoder().encode(value + "\r\n"))
        return yield* readReply()
      })

    const expect = (
      reply: Smtp.SmtpReply,
      codes: ReadonlyArray<number>,
      description: string
    ): Effect.Effect<void, TransportError> => {
      if (codes.includes(reply.code)) {
        return Effect.void
      }
      const message = `${description}: ${reply.code} ${
        reply.lines[0] ?? ""
      }`
      if (reply.code >= 500) {
        return Effect.fail(
          new ProviderRejected({
            message,
            provider: "smtp",
            status: reply.code
          })
        )
      }
      return Effect.fail(
        new TransportUnavailable({
          message,
          provider: "smtp",
          status: reply.code,
          retryable: true
        })
      )
    }

    const greetingReply = yield* readReply()
    yield* expect(greetingReply, [220], "SMTP greeting rejected")

    let ehlo = yield* command(`EHLO ${helo}`)
    yield* expect(ehlo, [250], "EHLO rejected")

    if (
      options.startTls === true &&
      options.secure !== true
    ) {
      if (
        !ehlo.lines.some(
          (line) => line.trim().toUpperCase() === "STARTTLS"
        )
      ) {
        return yield* new ProviderRejected({
          message: "SMTP server does not advertise STARTTLS",
          provider: "smtp"
        })
      }
      const started = yield* command("STARTTLS")
      yield* expect(started, [220], "STARTTLS rejected")
      yield* reader.upgrade(options.startTlsOptions).pipe(
        Effect.mapError((cause) =>
          socketFailure("SMTP TLS upgrade failed", cause, submitted)
        )
      )
      ehlo = yield* command(`EHLO ${helo}`)
      yield* expect(ehlo, [250], "EHLO after STARTTLS rejected")
    }

    if (options.auth !== undefined) {
      const secure =
        options.secure === true || options.startTls === true
      if (!secure && options.allowInsecureAuth !== true) {
        return yield* new UnsupportedCapability({
          message: "refusing SMTP AUTH over a plaintext connection",
          provider: "smtp",
          capability: "authentication"
        })
      }
      const token = Base64.encode(
        new TextEncoder().encode(
          `\u0000${options.auth.username}\u0000${Redacted.value(
            options.auth.password
          )}`
        )
      )
      const auth = yield* command(`AUTH PLAIN ${token}`)
      if (auth.code === 235) {
        // authenticated
      } else if (auth.code === 535) {
        return yield* new AuthenticationFailed({
          message: "SMTP authentication failed",
          provider: "smtp",
          status: auth.code
        })
      } else {
        yield* expect(auth, [235], "SMTP authentication failed")
      }
    }

    yield* Effect.addFinalizer(() =>
      command("QUIT").pipe(Effect.ignore)
    )

    const send = Effect.fnUntraced(function* (
      envelope: PreparedEnvelope
    ) {
      if (!healthy) {
        return yield* new TransportUnavailable({
          message: "SMTP connection is no longer healthy",
          provider: "smtp",
          retryable: true
        })
      }
      const unsigned = yield* buildMime(envelope.message)
      const mime =
        options.dkim === undefined
          ? unsigned
          : yield* Dkim.sign(unsigned, options.dkim).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRejected({
                    message: "SMTP DKIM signing failed",
                    provider: "smtp",
                    cause
                  })
              )
            )

      submitted = false
      const mail = yield* command(
        `MAIL FROM:<${envelope.message.from.address}>`
      )
      yield* expect(mail, [250], "MAIL FROM rejected")

      for (const address of [
        ...envelope.message.to,
        ...envelope.message.cc,
        ...envelope.message.bcc
      ]) {
        const rcpt = yield* command(`RCPT TO:<${address.address}>`)
        yield* expect(rcpt, [250, 251], "RCPT TO rejected")
      }

      const data = yield* command("DATA")
      yield* expect(data, [354], "DATA rejected")

      submitted = true
      const body = dotStuff(mime)
      const payload = endsWithCrlf(mime)
        ? concat([body, new TextEncoder().encode(".\r\n")])
        : concat([
            body,
            new TextEncoder().encode("\r\n.\r\n")
          ])
      yield* write(payload)

      const accepted = yield* readReply()
      yield* expect(accepted, [250], "Message rejected")

      const reset = yield* Effect.result(command("RSET"))
      if (
        reset._tag === "Failure" ||
        reset.success.code !== 250
      ) {
        healthy = false
      }
      const acceptedAt = yield* DateTime.now
      return receiptFor(envelope, destination, acceptedAt)
    })

    return { send, healthy: () => healthy }
  })

const makeTransport = (
  options: SmtpOptions,
  send: (
    envelope: PreparedEnvelope
  ) => Effect.Effect<SubmissionReceipt, TransportError>
): Transport => {
  const destination = makeDestination({
    provider: "smtp",
    account: options.account ?? `${options.host}:${options.port}`
  })
  return { destination, capabilities, send }
}

export const make = (
  options: SmtpOptions
): Effect.Effect<Transport> =>
  Effect.succeed(
    makeTransport(options, (envelope) =>
      Effect.scoped(
        Effect.flatMap(connect(options), (session) =>
          session.send(envelope)
        )
      )
    )
  )

export interface SmtpPoolOptions extends SmtpOptions {
  readonly poolSize?: number
}

export const makePooled = (
  options: SmtpPoolOptions
): Effect.Effect<Transport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pool = yield* Pool.make({
      acquire: connect(options).pipe(
        Effect.mapError((cause) =>
          socketFailure("SMTP connection failed", cause, false)
        )
      ),
      size: Math.max(1, options.poolSize ?? 4)
    })

    const attempt = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Pool.get(pool)
          const result = yield* Effect.result(session.send(envelope))
          if (result._tag === "Failure") {
            yield* Pool.invalidate(session)(pool)
            return yield* result.failure
          }
          if (!session.healthy()) {
            yield* Pool.invalidate(session)(pool)
          }
          return result.success
        })
      )

    const send = (
      envelope: PreparedEnvelope
    ): Effect.Effect<SubmissionReceipt, TransportError> =>
      Effect.gen(function* () {
        const first = yield* Effect.result(attempt(envelope))
        if (first._tag === "Success") {
          return first.success
        }
        if (certaintyOf(first.failure) === "unknown") {
          return yield* first.failure
        }
        return yield* attempt(envelope)
      })

    return makeTransport(options, send)
  })

export const layer = (
  options: SmtpOptions
): Layer.Layer<EmailTransport> =>
  Layer.effect(EmailTransport, make(options))

export const layerPooled = (
  options: SmtpPoolOptions
): Layer.Layer<EmailTransport> =>
  Layer.effect(EmailTransport, makePooled(options))
