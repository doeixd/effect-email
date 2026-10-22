import {
  Config,
  Context,
  Effect,
  Layer,
  pipe,
  Redacted
} from "effect"
import { Base64 } from "effect/encoding"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/http"
import { destinationId, makeDestination } from "../Ids"
import type { TransportError } from "../EmailError"
import {
  AuthenticationFailed,
  MalformedProviderResponse,
  ProviderRejected,
  RateLimited,
  TransportUnavailable
} from "../EmailError"
import type { Transport } from "../EmailTransport"
import { EmailTransport, makeCapabilities } from "../EmailTransport"
import * as Smtp from "./Smtp"

export interface MailpitOptions {
  readonly host?: string
  readonly port?: number
  readonly httpPort?: number
  readonly httpEndpoint?: string
  readonly webroot?: string
  readonly secure?: boolean
  readonly user?: string
  readonly password?: Redacted.Redacted<string>
  readonly apiUser?: string
  readonly apiPassword?: Redacted.Redacted<string>
  readonly account?: string
}

export interface MailpitInbox {
  readonly list: Effect.Effect<ReadonlyArray<unknown>, TransportError>
  readonly get: (id: string) => Effect.Effect<unknown, TransportError>
  readonly last: Effect.Effect<unknown | null, TransportError>
  readonly find: (
    address: string
  ) => Effect.Effect<ReadonlyArray<unknown>, TransportError>
  readonly raw: (id: string) => Effect.Effect<string, TransportError>
  readonly attachment: (
    id: string,
    partId: string
  ) => Effect.Effect<Uint8Array, TransportError>
  readonly clear: Effect.Effect<void, TransportError>
  readonly delete: (ids: string | ReadonlyArray<string>) => Effect.Effect<void, TransportError>
}

export interface MailpitClient {
  readonly transport: Transport
  readonly inbox: MailpitInbox
}

export class Client extends Context.Service<Client, MailpitClient>()(
  "@effect-email/providers/Mailpit/Client"
) {}

export const capabilities = makeCapabilities({
  nativeBatch: false,
  attachments: true,
  remoteAttachments: false,
  rawMime: true,
  tags: true,
  localTemplates: false,
  providerTemplates: false,
  retrieve: false,
  cancel: false,
  idempotency: "none"
})

const baseUrl = (options: MailpitOptions): string => {
  const host = options.host ?? "localhost"
  const root = (options.webroot ?? "").replace(/^\/+|\/+$/g, "")
  const prefix = root.length > 0 ? `/${root}` : ""
  return `${options.httpEndpoint ?? `http://${host}:${options.httpPort ?? 8025}`}${prefix}`
}

const request = (
  options: MailpitOptions,
  path: string,
  method: "GET" | "DELETE" | "PUT" = "GET",
  body?: unknown
): HttpClientRequest.HttpClientRequest => {
  let value = pipe(
    HttpClientRequest.make(method)(`${baseUrl(options)}${path}`),
    HttpClientRequest.setHeader("Accept", "application/json")
  )
  if (options.apiUser !== undefined) {
    const credentials = Base64.encode(
      new TextEncoder().encode(
        `${options.apiUser}:${
          options.apiPassword === undefined
            ? ""
            : Redacted.value(options.apiPassword)
        }`
      )
    )
    value = HttpClientRequest.setHeader(
      value,
      "Authorization",
      `Basic ${credentials}`
    )
  }
  if (body !== undefined) {
    value = HttpClientRequest.setHeader(
      value,
      "Content-Type",
      "application/json"
    )
    value = HttpClientRequest.bodyJsonUnsafe(value, body)
  }
  return value
}

const execute = (
  client: HttpClient.HttpClient,
  value: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
  client.execute(value).pipe(
    Effect.mapError(
      (cause) =>
        new TransportUnavailable({
          message: "Mailpit request failed",
          provider: "mailpit",
          retryable: true,
          cause
        })
    )
  )

const failure = (
  response: HttpClientResponse.HttpClientResponse
): TransportError => {
  const common = {
    message: `Mailpit request failed with status ${response.status}`,
    provider: "mailpit",
    status: response.status
  }
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationFailed(common)
  }
  if (response.status === 429) {
    return new RateLimited({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return new TransportUnavailable({ ...common, retryable: true })
  }
  return new ProviderRejected(common)
}

const readJson = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<unknown, TransportError> =>
  response.json.pipe(
    Effect.mapError(
      (cause) =>
        new MalformedProviderResponse({
          message: "Mailpit returned unreadable JSON",
          provider: "mailpit",
          status: response.status,
          cause
        })
    )
  )

const emptyRequest = (
  client: HttpClient.HttpClient,
  options: MailpitOptions,
  path: string,
  method: "GET" | "DELETE" | "PUT" = "GET",
  body?: unknown,
  allow404 = false
): Effect.Effect<void, TransportError> =>
  Effect.gen(function* () {
    const response = yield* execute(client, request(options, path, method, body))
    if (response.status === 404 && allow404) {
      return
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(response)
    }
  })

const jsonRequest = (
  client: HttpClient.HttpClient,
  options: MailpitOptions,
  path: string,
  method: "GET" | "DELETE" | "PUT" = "GET",
  body?: unknown,
  allow404 = false
): Effect.Effect<unknown, TransportError> =>
  Effect.gen(function* () {
    const response = yield* execute(client, request(options, path, method, body))
    if (response.status === 404 && allow404) {
      return null
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(response)
    }
    return yield* readJson(response)
  })

export const makeClient = (
  options: MailpitOptions = {}
): Effect.Effect<MailpitClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const smtp = yield* Smtp.make({
      host: options.host ?? "localhost",
      port: options.port ?? 1025,
      ...(options.secure === undefined ? {} : { secure: options.secure }),
      ...(options.user === undefined || options.password === undefined
        ? {}
        : {
            auth: {
              username: options.user,
              password: options.password
            }
          })
    })
    const destination = makeDestination({
      provider: "mailpit",
      account: options.account ?? "default"
    })
    const resolvedDestinationId = destinationId(destination)
    const transport: Transport = {
      destination,
      capabilities,
      send: (envelope) =>
        Effect.map(smtp.send(envelope), (receipt) => ({
          ...receipt,
          provider: "mailpit",
          destinationId: resolvedDestinationId
        }))
    }

    const list = Effect.map(
      jsonRequest(client, options, "/api/v1/messages"),
      (body) =>
        ((body as { messages?: ReadonlyArray<unknown> }).messages ?? [])
    )

    const get = (id: string) =>
      jsonRequest(
        client,
        options,
        `/api/v1/message/${encodeURIComponent(id)}`
      )

    const last = Effect.map(
      jsonRequest(
        client,
        options,
        "/api/v1/message/latest",
        "GET",
        undefined,
        true
      ),
      (body) => body
    )

    const find = (address: string) =>
      Effect.map(
        jsonRequest(
          client,
          options,
          `/api/v1/search?query=${encodeURIComponent(
            `addressed:${address}`
          )}`
        ),
        (body) => {
          const target = address.toLowerCase()
          const messages = (
            body as { messages?: ReadonlyArray<unknown> }
          ).messages ?? []
          return messages.filter((message) => {
            const value = message as {
              To?: ReadonlyArray<{ Address?: string }>
              Cc?: ReadonlyArray<{ Address?: string }>
              Bcc?: ReadonlyArray<{ Address?: string }>
            }
            return [
              ...(value.To ?? []),
              ...(value.Cc ?? []),
              ...(value.Bcc ?? [])
            ].some(
              (entry) => entry.Address?.toLowerCase() === target
            )
          })
        }
      )

    const raw = (id: string) =>
      Effect.gen(function* () {
        const response = yield* execute(
          client,
          request(
            options,
            `/api/v1/message/${encodeURIComponent(id)}/raw`
          )
        )
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(response)
        }
        return yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              new MalformedProviderResponse({
                message: "Mailpit returned an unreadable raw message",
                provider: "mailpit",
                status: response.status,
                cause
              })
          )
        )
      })

    const attachment = (id: string, partId: string) =>
      Effect.gen(function* () {
        const response = yield* execute(
          client,
          request(
            options,
            `/api/v1/message/${encodeURIComponent(
              id
            )}/part/${encodeURIComponent(partId)}`
          )
        )
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(response)
        }
        return new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.mapError(
              (cause) =>
                new MalformedProviderResponse({
                  message:
                    "Mailpit returned unreadable attachment bytes",
                  provider: "mailpit",
                  status: response.status,
                  cause
                })
            )
          )
        )
      })

    const remove = (ids: string | ReadonlyArray<string>) => {
      const list = typeof ids === "string" ? [ids] : ids
      if (list.length === 0) return Effect.void
      return emptyRequest(
        client,
        options,
        "/api/v1/messages",
        "DELETE",
        { IDs: [...list] }
      )
    }

    const clear = emptyRequest(
      client,
      options,
      "/api/v1/messages",
      "DELETE"
    )

    return {
      transport,
      inbox: {
        list,
        get,
        last,
        find,
        raw,
        attachment,
        clear,
        delete: remove
      }
    }
  })

export const make = (
  options: MailpitOptions = {}
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailpitOptions = {}
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailpitOptions = {}
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport

export const layerConfig = (
  options: Omit<MailpitOptions, "user" | "password"> = {}
): Layer.Layer<EmailTransport, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        user: Config.String("MAILPIT_USER"),
        password: Config.Redacted("MAILPIT_PASSWORD")
      }),
      ({ user, password }) =>
        layerTransport({
          ...options,
          user,
          password
        })
    )
  )
