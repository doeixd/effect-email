import { Effect, Scope } from "effect"
import * as HttpServer from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/http/HttpServerResponse"
import { NetAddress } from "effect/net"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"

export interface NodeServer {
  readonly url: string
  readonly port: number
}

export const serve = <R>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    R
  >,
  options: NodeHttpServer.Options = {}
): Effect.Effect<
  NodeServer,
  ServeError,
  Exclude<R, HttpServerRequest.HttpServerRequest> | Scope.Scope
> =>
  Effect.gen(function* () {
    const server = yield* NodeHttpServer.make(
      () => createServer(),
      options
    )
    yield* server.serve(app)
    return {
      url: NetAddress.formatUrlUnsafe(server.address),
      port:
        "port" in server.address ? server.address.port : 0
    }
  })
