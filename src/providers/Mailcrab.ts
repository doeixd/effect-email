import {
  Context,
  Effect,
  Layer,
  pipe,
  Redacted
} from "effect"
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

export interface MailcrabOptions {
  readonly host?: string
  readonly port?: number
  readonly httpPort?: number
  readonly httpEndpoint?: string
  readonly prefix?: string
  readonly secure?: boolean
  readonly user?: string
  readonly password?: Redacted.Redacted<string>
  readonly account?: string
}

export interface MailcrabInbox {
  readonly list: Effect.Effect<ReadonlyArray<unknown>, TransportError>
  readonly get: (id: string) => Effect.Effect<unknown, TransportError>
  readonly last: Effect.Effect<unknown | null, TransportError>
  readonly find: (
    address: string
  ) => Effect.Effect<ReadonlyArray<unknown>, TransportError>
  readonly raw: (id: string) => Effect.Effect<string, TransportError>
  readonly attachment: (
    id: string,
    index: number
  ) => Effect.Effect<Uint8Array, TransportError>
  readonly delete: (id: string) => Effect.Effect<void, TransportError>
  readonly clear: Effect.Effect<void, TransportError>
}

export interface MailcrabClient {
  readonly transport: Transport
  readonly inbox: MailcrabInbox
}

export class Client extends Context.Service<Client, MailcrabClient>()(
  "@effect-email/providers/Mailcrab/Client"
) {}

export const capabilities = makeCapabilities({
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

const baseUrl = (options: MailcrabOptions): string => {
  const host = options.host ?? "localhost"
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "")
  return `${
    options.httpEndpoint ?? `http://${host}:${options.httpPort ?? 1080}`
  }${prefix.length > 0 ? `/${prefix}` : ""}`
}

const request = (
  options: MailcrabOptions,
  path: string,
  method: "GET" | "POST" = "GET"
): HttpClientRequest.HttpClientRequest =>
  pipe(
    HttpClientRequest.make(method)(`${baseUrl(options)}${path}`),
    HttpClientRequest.setHeader("Accept", "application/json")
  )

const execute = (
  client: HttpClient.HttpClient,
  value: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError> =>
  client.execute(value).pipe(
    Effect.mapError(
      (cause) =>
        TransportUnavailable.new({
          message: "Mailcrab request failed",
          provider: "mailcrab",
          retryable: true,
          cause
        })
    )
  )

const failure = (
  response: HttpClientResponse.HttpClientResponse
): TransportError => {
  const common = {
    message: `Mailcrab request failed with status ${response.status}`,
    provider: "mailcrab",
    status: response.status
  }
  if (response.status === 401 || response.status === 403) {
    return AuthenticationFailed.new(common)
  }
  if (response.status === 429) {
    return RateLimited.new({ ...common, retryable: true })
  }
  if (response.status >= 500) {
    return TransportUnavailable.new({ ...common, retryable: true })
  }
  return ProviderRejected.new(common)
}

const json = (
  client: HttpClient.HttpClient,
  options: MailcrabOptions,
  path: string,
  method: "GET" | "POST" = "GET"
): Effect.Effect<unknown, TransportError> =>
  Effect.gen(function* () {
    const response = yield* execute(
      client,
      request(options, path, method)
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(response)
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          MalformedProviderResponse.new({
            message: "Mailcrab returned unreadable JSON",
            provider: "mailcrab",
            status: response.status,
            cause
          })
      )
    )
  })

const executeEmpty = (
  client: HttpClient.HttpClient,
  options: MailcrabOptions,
  path: string,
  method: "GET" | "POST" = "GET"
): Effect.Effect<void, TransportError> =>
  Effect.gen(function* () {
    const response = yield* execute(client, request(options, path, method))
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(response)
    }
  })

export const makeClient = (
  options: MailcrabOptions = {}
): Effect.Effect<MailcrabClient, never, HttpClient.HttpClient> =>
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
      provider: "mailcrab",
      account: options.account ?? "default"
    })
    const resolvedDestinationId = destinationId(destination)
    const transport: Transport = {
      destination,
      capabilities,
      send: (envelope) =>
        Effect.map(smtp.send(envelope), (receipt) => ({
          ...receipt,
          provider: "mailcrab",
          destinationId: resolvedDestinationId
        }))
    }

    const list = Effect.map(
      json(client, options, "/api/messages"),
      (body) => {
        const messages = (body as ReadonlyArray<unknown>) ?? []
        return [...messages].sort((left, right) => {
          const a = (left as { time?: number }).time ?? 0
          const b = (right as { time?: number }).time ?? 0
          return b - a
        })
      }
    )

    const get = (id: string) =>
      json(
        client,
        options,
        `/api/message/${encodeURIComponent(id)}`
      )

    const last = Effect.gen(function* () {
      const messages = yield* list
      const newest = messages[0]
      if (newest === undefined) {
        return null
      }
      const id = (newest as { id?: string }).id
      return id === undefined ? null : yield* get(id)
    })

    const find = (address: string) =>
      Effect.map(list, (messages) => {
        const target = address.toLowerCase()
        return messages.filter((message) => {
          const value = message as {
            to?: ReadonlyArray<{ email?: string | null }>
            envelope_recipients?: ReadonlyArray<string>
          }
          return (
            (value.to ?? []).some(
              (entry) => entry.email?.toLowerCase() === target
            ) ||
            (value.envelope_recipients ?? []).some(
              (entry) => entry.toLowerCase() === target
            )
          )
        })
      })

    const raw = (id: string) =>
      Effect.gen(function* () {
        const response = yield* execute(
          client,
          request(
            options,
            `/api/message/${encodeURIComponent(id)}/raw`
          )
        )
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(response)
        }
        return yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              MalformedProviderResponse.new({
                message: "Mailcrab returned an unreadable raw message",
                provider: "mailcrab",
                status: response.status,
                cause
              })
          )
        )
      })

    const attachment = (id: string, index: number) =>
      Effect.gen(function* () {
        const response = yield* execute(
          client,
          request(
            options,
            `/api/message/${encodeURIComponent(
              id
            )}/attachment/${index}`
          )
        )
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(response)
        }
        return new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.mapError(
              (cause) =>
                MalformedProviderResponse.new({
                  message:
                    "Mailcrab returned unreadable attachment bytes",
                  provider: "mailcrab",
                  status: response.status,
                  cause
                })
            )
          )
        )
      })

    const remove = (id: string) =>
      executeEmpty(
        client,
        options,
        `/api/delete/${encodeURIComponent(id)}`,
        "POST"
      )

    const clear = executeEmpty(
      client,
      options,
      "/api/delete-all",
      "POST"
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
        delete: remove,
        clear
      }
    }
  })

export const make = (
  options: MailcrabOptions = {}
): Effect.Effect<Transport, never, HttpClient.HttpClient> =>
  Effect.map(makeClient(options), (client) => client.transport)

export const layerClient = (
  options: MailcrabOptions = {}
): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, makeClient(options))

const layerTransportFromClient = Layer.effect(
  EmailTransport,
  Effect.map(Client, (client) => client.transport)
)

export const layerTransport = (
  options: MailcrabOptions = {}
): Layer.Layer<EmailTransport, never, HttpClient.HttpClient> =>
  layerTransportFromClient.pipe(Layer.provide(layerClient(options)))

export const layer = layerTransport
