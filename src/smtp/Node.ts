import { Duration, Effect, Option, Scope, Semaphore } from "effect"
import type { NetAddress } from "effect/net"
import * as Socket from "effect/socket/Socket"
import type { SocketServerError } from "effect/socket/SocketServer"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import type { EmailError } from "../EmailError"
import type { TlsOptions } from "node:tls"
import type { SmtpSubmission } from "./Protocol"
import {
  runSession,
  SmtpConnectionError
} from "./Session"

export interface NodeSmtpOptions {
  readonly host?: string
  readonly port?: number
  readonly admit: (
    submission: SmtpSubmission
  ) => Effect.Effect<void, EmailError>
  readonly maxLineBytes?: number
  readonly maxMessageBytes?: number
  readonly maxRecipients?: number
  readonly maxConnections?: number
  readonly maxSessionMillis?: number
  readonly authenticate?: (
    credentials: import("./Session").SmtpCredentials
  ) => Effect.Effect<void, EmailError>
  readonly requireAuthentication?: boolean
  readonly allowInsecureAuth?: boolean
  readonly tls?: TlsOptions
  readonly startTls?: Socket.TlsUpgradeOptions
}

export interface NodeSmtpServer {
  readonly address: NetAddress.SocketAddress
  readonly run: Effect.Effect<never, SocketServerError>
}

const concat = (
  chunks: ReadonlyArray<Uint8Array>
): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const connectionFor = (
  socket: Socket.Socket,
  options: NodeSmtpOptions
) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    return {
      read: reader.pull.pipe(
        Effect.map((chunks) =>
          concat(
            chunks.map((chunk) =>
              typeof chunk === "string"
                ? new TextEncoder().encode(chunk)
                : chunk
            )
          )
        ),
        Effect.mapError(
          (cause) =>
            new SmtpConnectionError({
              message: "SMTP socket read failed",
              cause
            })
        )
      ),
      upgradeTls: (upgradeOptions: Socket.TlsUpgradeOptions) =>
        reader.upgrade(upgradeOptions).pipe(
          Effect.mapError(
            (cause) =>
              new SmtpConnectionError({
                message: "SMTP TLS upgrade failed",
                cause
              })
          )
        ),
      write: (chunk: Uint8Array) =>
        writer.write(chunk).pipe(
          Effect.mapError(
            (cause) =>
              new SmtpConnectionError({
                message: "SMTP socket write failed",
                cause
              })
          )
        )
    }
  })

export const start = (
  options: NodeSmtpOptions
): Effect.Effect<
  NodeSmtpServer,
  SocketServerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const listen = {
      host: options.host,
      port: options.port ?? 0
    }
    const server =
      options.tls === undefined
        ? yield* NodeSocketServer.make(listen)
        : yield* NodeSocketServer.makeTls({
            ...options.tls,
            ...listen
          })

    const maxConnections = options.maxConnections
    const connectionLimit =
      maxConnections !== undefined &&
      Number.isFinite(maxConnections) &&
      maxConnections >= 1
        ? yield* Semaphore.make(Math.floor(maxConnections))
        : undefined
    const maxSessionMillis =
      options.maxSessionMillis !== undefined &&
      Number.isFinite(options.maxSessionMillis) &&
      options.maxSessionMillis >= 1
        ? Math.floor(options.maxSessionMillis)
        : undefined

    const handleSocket = (socket: Socket.Socket) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connectionFor(socket, options)
          const session = runSession({
            connection,
            admit: options.admit,
            ...(options.maxLineBytes === undefined
              ? {}
              : { maxLineBytes: options.maxLineBytes }),
            ...(options.maxMessageBytes === undefined
              ? {}
              : { maxMessageBytes: options.maxMessageBytes }),
            ...(options.maxRecipients === undefined
              ? {}
              : { maxRecipients: options.maxRecipients }),
            ...(options.authenticate === undefined
              ? {}
              : { authenticate: options.authenticate }),
            ...(options.requireAuthentication === undefined
              ? {}
              : {
                  requireAuthentication:
                    options.requireAuthentication
                }),
            ...(options.allowInsecureAuth === undefined
              ? {}
              : { allowInsecureAuth: options.allowInsecureAuth }),
            ...(options.startTls === undefined
              ? {}
              : {
                  upgradeTls: connection.upgradeTls(
                    options.startTls
                  )
                }),
            tls: options.tls !== undefined
          })
          yield* maxSessionMillis === undefined
            ? session
            : Effect.timeout(
                session,
                Duration.millis(maxSessionMillis)
              ).pipe(Effect.asVoid)
        })
      ).pipe(Effect.catch(() => Effect.void))

    const handler = (socket: Socket.Socket) =>
      connectionLimit === undefined
        ? handleSocket(socket)
        : connectionLimit
            .withPermitsIfAvailable(1)(handleSocket(socket))
            .pipe(Effect.asVoid, Effect.catch(() => Effect.void))

    return {
      address: server.address,
      run: server.run(handler)
    }
  })

export const serve = (
  options: NodeSmtpOptions
): Effect.Effect<never, SocketServerError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* start(options)
      return yield* server.run
    })
  )
