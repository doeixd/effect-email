import { Effect, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { EmailError } from "../EmailError"
import * as Smtp from "./Protocol"

export class SmtpConnectionError extends Schema.TaggedError<SmtpConnectionError>()(
  "SmtpConnectionError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface SmtpConnection {
  readonly read: Effect.Effect<Uint8Array, SmtpConnectionError>
  readonly write: (
    chunk: Uint8Array
  ) => Effect.Effect<void, SmtpConnectionError>
}

export interface SmtpCredentials {
  readonly username: string
  readonly password: string
}

export interface SmtpSessionOptions {
  readonly connection: SmtpConnection
  readonly admit: (
    submission: Smtp.SmtpSubmission
  ) => Effect.Effect<void, EmailError>
  readonly authenticate?: (
    credentials: SmtpCredentials
  ) => Effect.Effect<void, EmailError>
  readonly requireAuthentication?: boolean
  readonly allowInsecureAuth?: boolean
  readonly tls?: boolean
  readonly upgradeTls?: Effect.Effect<void, SmtpConnectionError>
  readonly maxLineBytes?: number
  readonly maxMessageBytes?: number
  readonly maxRecipients?: number
}

const failureReply = (error: EmailError): Smtp.SmtpReply => {
  switch (error._tag) {
    case "RateLimited":
    case "TransportUnavailable":
    case "StoreUnavailable":
      return { code: 451, lines: ["Requested action aborted; try again"] }
    default:
      return { code: 550, lines: ["Message rejected"] }
  }
}

const resetSession = (
  session: Smtp.SmtpSessionState
): Smtp.SmtpSessionState =>
  Smtp.transition(session, {
    name: "RSET",
    argument: ""
  }).state

export const runSession = (
  options: SmtpSessionOptions
): Effect.Effect<void, SmtpConnectionError> =>
  Effect.gen(function* () {
    const limit = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : fallback
    const maxLineBytes = limit(options.maxLineBytes, 512)
    const maxMessageBytes = limit(
      options.maxMessageBytes,
      25 * 1024 * 1024
    )
    const maxRecipients = limit(options.maxRecipients, 100)
    const requireAuthentication =
      options.requireAuthentication ?? options.authenticate !== undefined
    let tlsActive = options.tls === true
    let session = Smtp.initialSession
    let frame = Smtp.emptyLineFrame
    let decoder = Smtp.emptyDataDecoder

    yield* options.connection.write(Smtp.encodeReply(Smtp.greeting))

    while (true) {
      const chunk = yield* options.connection.read
      let pending = chunk

      while (true) {
        if (session.phase === "data") {
          const dataChunk =
            pending.length === 0 ? frame.buffer : pending
          frame = Smtp.emptyLineFrame
          pending = new Uint8Array()
          const decoded = Smtp.pushData(
            decoder,
            dataChunk,
            maxMessageBytes
          )
          decoder = decoded.decoder
          if (!decoded.complete) {
            break
          }
          if (decoded.tooLarge) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 552,
                lines: ["Message size exceeds fixed maximum"]
              })
            )
            session = resetSession(session)
            frame = Smtp.emptyLineFrame
          } else {
            const complete = Smtp.completeData(
              session,
              decoded.content!
            )
            const accepted = yield* Effect.result(
              options.admit(complete.submission!)
            )
            yield* options.connection.write(
              Smtp.encodeReply(
                accepted._tag === "Success"
                  ? {
                      code: 250,
                      lines: ["Message accepted"]
                    }
                  : failureReply(accepted.failure)
              )
            )
            session = complete.state
            frame = Smtp.emptyLineFrame
          }
          if (decoded.remainder !== undefined) {
            frame = {
              buffer: decoded.remainder,
              discarding: false
            }
            pending = new Uint8Array()
            continue
          }
          break
        }

        const read = Smtp.takeLine(frame, pending, maxLineBytes)
        frame = read.frame
        pending = new Uint8Array()

        if (read.overflow) {
          yield* options.connection.write(
            Smtp.encodeReply({
              code: 500,
              lines: ["Line too long"]
            })
          )
          continue
        }
        if (read.line === undefined) {
          break
        }

        const command = Smtp.parseCommand(
          new TextDecoder().decode(read.line)
        )

        if (command.name === "STARTTLS") {
          if (
            options.upgradeTls === undefined ||
            tlsActive ||
            session.phase !== "command" ||
            session.helo === undefined ||
            session.mailFrom !== undefined ||
            session.recipients.length > 0 ||
            session.authenticated
          ) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 503,
                lines: ["STARTTLS not permitted now"]
              })
            )
            continue
          }
          yield* options.connection.write(
            Smtp.encodeReply({
              code: 220,
              lines: ["Ready to start TLS"]
            })
          )
          yield* options.upgradeTls
          tlsActive = true
          session = Smtp.initialSession
          frame = Smtp.emptyLineFrame
          decoder = Smtp.emptyDataDecoder
          continue
        }

        const authAvailable =
          options.authenticate !== undefined &&
          (tlsActive || options.allowInsecureAuth === true)

        if (command.name === "AUTH") {
          if (!authAvailable || options.authenticate === undefined) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 502,
                lines: ["Authentication not available"]
              })
            )
            continue
          }
          if (session.authenticated) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 503,
                lines: ["Already authenticated"]
              })
            )
            continue
          }
          const match = /^PLAIN(?:\s+(.+))?$/i.exec(
            command.argument.trim()
          )
          if (match === null || match[1] === undefined) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 501,
                lines: ["AUTH PLAIN requires an initial response"]
              })
            )
            continue
          }
          const decoded = Base64.decodeString(match[1])
          if (Result.isFailure(decoded)) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 501,
                lines: ["Invalid base64 credentials"]
              })
            )
            continue
          }
          const parts = decoded.success.split("\u0000")
          if (parts.length < 3) {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 501,
                lines: ["Invalid PLAIN credentials"]
              })
            )
            continue
          }
          const authenticated = yield* Effect.result(
            options.authenticate({
              username: parts[parts.length - 2]!,
              password: parts[parts.length - 1]!
            })
          )
          if (authenticated._tag === "Failure") {
            yield* options.connection.write(
              Smtp.encodeReply({
                code: 535,
                lines: ["Authentication failed"]
              })
            )
            continue
          }
          session = { ...session, authenticated: true }
          yield* options.connection.write(
            Smtp.encodeReply({
              code: 235,
              lines: ["Authentication successful"]
            })
          )
          continue
        }

        if (
          requireAuthentication &&
          !session.authenticated &&
          (command.name === "MAIL" ||
            command.name === "RCPT" ||
            command.name === "DATA")
        ) {
          yield* options.connection.write(
            Smtp.encodeReply({
              code: 530,
              lines: ["Authentication required"]
            })
          )
          continue
        }

        if (
          command.name === "RCPT" &&
          session.recipients.length >= maxRecipients
        ) {
          yield* options.connection.write(
            Smtp.encodeReply({
              code: 452,
              lines: ["Too many recipients"]
            })
          )
          continue
        }

        const transitioned = Smtp.transition(session, command)
        session = transitioned.state
        const capabilities = [
          ...(options.upgradeTls !== undefined && !tlsActive
            ? ["STARTTLS"]
            : []),
          ...(authAvailable ? ["AUTH PLAIN"] : [])
        ]
        const responses =
          command.name === "EHLO" && capabilities.length > 0
            ? transitioned.replies.map((response) =>
                response.code === 250
                  ? {
                      ...response,
                      lines: [...response.lines, ...capabilities]
                    }
                  : response
              )
            : transitioned.replies
        for (const response of responses) {
          yield* options.connection.write(Smtp.encodeReply(response))
        }
        if (transitioned.close === true) {
          return
        }
        if (transitioned.beginData === true) {
          decoder = Smtp.emptyDataDecoder
          continue
        }
      }
    }
  })
