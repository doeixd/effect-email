import { Context, Effect, Layer, Result, Stream } from "effect"
import type { DeliveryId, RouteName } from "./Ids"
import { destinationId, newDeliveryId, routeName } from "./Ids"
import type { EmailError } from "./EmailError"
import {
  certaintyOf,
  ConfigurationError,
  DeliveryUncertain,
  UnsupportedCapability
} from "./EmailError"
import type {
  MailboxInput,
  MessageDraft,
  MessageInput,
  NormalizedAddress,
  PreparedMessage
} from "./Message"
import { normalizeMailbox, prepare } from "./Message"
import type {
  DeliveryStatus,
  MessageOutcome,
  PreparedEnvelope,
  SubmissionReceipt
} from "./Submission"
import { BatchExecutionError } from "./Submission"
import type { Transport, NativeBatchTransport } from "./EmailTransport"
import { isNativeBatchTransport } from "./EmailTransport"
import { checkCapabilities } from "./Capabilities"
import type { RendererShape } from "./render/Template"
import type { TransportRegistryShape } from "./TransportRegistry"
import { TransportRegistry } from "./TransportRegistry"

export interface SendOptions {
  readonly route?: RouteName
  readonly deliveryId?: DeliveryId
  readonly providerIdempotencyKey?: string
}

export interface BatchOptions {
  readonly route?: RouteName
  readonly concurrency?: number
  readonly providerIdempotencyKey?: string
}

export interface StreamOptions extends BatchOptions {
  readonly chunkSize?: number
}

export interface EmailShape {
  readonly send: (
    input: MessageInput | MessageDraft,
    options?: SendOptions
  ) => Effect.Effect<SubmissionReceipt, EmailError>
  readonly sendBatch: (
    inputs: ReadonlyArray<MessageInput | MessageDraft>,
    options?: BatchOptions
  ) => Effect.Effect<ReadonlyArray<MessageOutcome>, BatchExecutionError>
  readonly sendStream: (
    inputs: Stream.Stream<MessageInput | MessageDraft>,
    options?: StreamOptions
  ) => Stream.Stream<MessageOutcome, BatchExecutionError>
  readonly retrieve: (
    receipt: SubmissionReceipt
  ) => Effect.Effect<DeliveryStatus, EmailError>
  readonly cancel: (
    receipt: SubmissionReceipt
  ) => Effect.Effect<void, EmailError>
}

export class Email extends Context.Service<Email, EmailShape>()(
  "@effect-email/Email"
) {
  static layer(options: EmailOptions): Layer.Layer<Email> {
    return Layer.effect(
      Email,
      Effect.sync(() => {
        const from = normalizeMailbox(options.defaultFrom)
        const routes = new Map<string, Transport>(
          Object.entries(options.routes)
        )
        if (routes.size === 0) {
          throw new Error("Email.layer requires at least one route")
        }
        return Email.of(
          makeEmailShape(
            from,
            routes,
            resolveDefaultRoute(options.defaultRoute, routes),
            options.renderer
          )
        )
      })
    )
  }

  static layerValidated(
    options: EmailOptions
  ): Effect.Effect<Layer.Layer<Email>, ConfigurationError> {
    return Effect.gen(function* () {
      const from = yield* Effect.try({
        try: () => normalizeMailbox(options.defaultFrom),
        catch: (cause) =>
          new ConfigurationError({
            message:
              cause instanceof Error
                ? cause.message
                : `invalid default sender: ${String(cause)}`
          })
      })
      const routes = new Map<string, Transport>(
        Object.entries(options.routes)
      )
      if (routes.size === 0) {
        return yield* new ConfigurationError({
          message: "Email.layer requires at least one route"
        })
      }
      const defaultRoute = yield* Effect.try({
        try: () =>
          resolveDefaultRoute(options.defaultRoute, routes),
        catch: (cause) =>
          new ConfigurationError({
            message:
              cause instanceof Error
                ? cause.message
                : String(cause)
          })
      })
      return Layer.succeed(
        Email,
        Email.of(
          makeEmailShape(
            from,
            routes,
            defaultRoute,
            options.renderer
          )
        )
      )
    })
  }
  static layerFromRegistry(options: {
    readonly defaultFrom: MailboxInput
    readonly registry: TransportRegistryShape
    readonly defaultRoute?: RouteName
    readonly renderer?: RendererShape
  }): Layer.Layer<Email, UnsupportedCapability> {
    return Layer.effect(
      Email,
      makeFromRegistry(
        options.defaultFrom,
        options.registry,
        options.defaultRoute,
        options.renderer
      )
    )
  }

  static layerFromRegistryLayer<R = never, E = never>(options: {
    readonly defaultFrom: MailboxInput
    readonly registry: Layer.Layer<TransportRegistry, E, R>
    readonly defaultRoute?: RouteName
    readonly renderer?: RendererShape
  }): Layer.Layer<Email, E | UnsupportedCapability, R> {
    return Layer.effect(
      Email,
      Effect.flatMap(TransportRegistry, (registry) =>
        makeFromRegistry(
          options.defaultFrom,
          registry,
          options.defaultRoute,
          options.renderer
        )
      )
    ).pipe(Layer.provide(options.registry))
  }

  static layerTransport(options: {
    readonly defaultFrom: MailboxInput
    readonly transport: Transport
    readonly route?: RouteName
  }): Layer.Layer<Email> {
    const route = options.route ?? routeName("default")
    return Email.layer({
      defaultFrom: options.defaultFrom,
      defaultRoute: route,
      routes: { [route]: options.transport }
    })
  }
}

const makeFromRegistry = (
  defaultFrom: MailboxInput,
  registry: TransportRegistryShape,
  defaultRoute: RouteName | undefined,
  renderer: RendererShape | undefined
): Effect.Effect<EmailShape, UnsupportedCapability> =>
  Effect.gen(function* () {
    const from = normalizeMailbox(defaultFrom)
    const names = yield* registry.routes
    const entries = yield* Effect.forEach(
      names,
      (route) =>
        Effect.map(registry.get(route), (transport) => [
          route,
          transport
        ] as const)
    )
    const routes = new Map<string, Transport>(entries)
    if (routes.size === 0) {
      throw new Error(
        "Email.layerFromRegistry requires at least one route"
      )
    }
    const requested = defaultRoute ?? registry.defaultRoute
    return Email.of(
      makeEmailShape(
        from,
        routes,
        resolveDefaultRoute(requested, routes),
        renderer
      )
    )
  })

const makeEmailShape = (
  from: NormalizedAddress,
  routes: ReadonlyMap<string, Transport>,
  defaultRoute: RouteName,
  renderer: RendererShape | undefined
): EmailShape => {
  const send = makeSend(from, defaultRoute, routes, renderer)
  const sendBatch = makeSendBatch(
    from,
    defaultRoute,
    routes,
    renderer
  )
  return {
    send,
    sendBatch,
    sendStream: makeSendStream(sendBatch),
    retrieve: makeRetrieve(routes),
    cancel: makeCancel(routes)
  }
}

export interface EmailOptions {
  readonly defaultFrom: MailboxInput
  readonly defaultRoute?: RouteName
  readonly routes: Readonly<Record<string, Transport>>
  readonly renderer?: RendererShape
}

const resolveDefaultRoute = (
  requested: RouteName | undefined,
  routes: ReadonlyMap<string, Transport>
): RouteName => {
  if (requested !== undefined) {
    if (!routes.has(requested)) {
      throw new Error(`default route not found: ${requested}`)
    }
    return requested
  }
  if (routes.has("default")) {
    return routeName("default")
  }
  if (routes.size === 1) {
    return routeName(routes.keys().next().value as string)
  }
  throw new Error(
    "Email.layer requires defaultRoute when multiple routes are configured"
  )
}

const makeEnvelope = (
  message: PreparedMessage,
  selectedRoute: RouteName,
  transport: Transport,
  providerIdempotencyKey?: string
): PreparedEnvelope => {
  const destination = transport.destination
  return Object.freeze({
    message,
    deliveryId: message.deliveryId!,
    route: selectedRoute,
    destination,
    destinationId: destinationId(destination),
    ...(providerIdempotencyKey === undefined
      ? {}
      : { providerIdempotencyKey })
  })
}

const finalizeReceipt = (
  receipt: SubmissionReceipt,
  envelope: PreparedEnvelope
): SubmissionReceipt => ({
  ...receipt,
  deliveryId: receipt.deliveryId ?? envelope.deliveryId,
  provider: receipt.provider || envelope.destination.provider,
  destinationId: receipt.destinationId ?? envelope.destinationId,
  route: receipt.route ?? envelope.route
})

const transportForReceipt = (
  routes: ReadonlyMap<string, Transport>,
  receipt: SubmissionReceipt
): Transport | undefined => {
  const direct = [...routes.values()].find(
    (transport) =>
      destinationId(transport.destination) === receipt.destinationId
  )
  if (direct !== undefined) {
    return direct
  }
  const matching = [...routes.values()].filter(
    (transport) => transport.destination.provider === receipt.provider
  )
  if (matching.length === 1) {
    return matching[0]
  }
  return routes.size === 1
    ? [...routes.values()][0]
    : undefined
}

const makeRetrieve = (
  routes: ReadonlyMap<string, Transport>
): EmailShape["retrieve"] =>
  Effect.fn("Email.retrieve")(function* (receipt) {
    const transport = transportForReceipt(routes, receipt)
    if (transport?.retrieve === undefined) {
      return yield* new UnsupportedCapability({
        message: `destination does not support retrieval: ${receipt.destinationId}`,
        provider: receipt.provider,
        capability: "retrieve"
      })
    }
    return yield* transport.retrieve(receipt)
  })

const makeCancel = (
  routes: ReadonlyMap<string, Transport>
): EmailShape["cancel"] =>
  Effect.fn("Email.cancel")(function* (receipt) {
    const transport = transportForReceipt(routes, receipt)
    if (transport?.cancel === undefined) {
      return yield* new UnsupportedCapability({
        message: `destination does not support cancellation: ${receipt.destinationId}`,
        provider: receipt.provider,
        capability: "cancel"
      })
    }
    return yield* transport.cancel(receipt)
  })

const renderIfNeeded = (
  message: PreparedMessage,
  renderer: RendererShape | undefined
): Effect.Effect<PreparedMessage, EmailError> => {
  if (message.content._tag !== "template" || renderer === undefined) {
    return Effect.succeed(message)
  }
  return Effect.map(renderer.render(message.content), (content) =>
    Object.freeze({ ...message, content })
  )
}

const makeSend = (
  defaultFrom: NormalizedAddress,
  defaultRoute: RouteName,
  routes: ReadonlyMap<string, Transport>,
  renderer: RendererShape | undefined
): EmailShape["send"] =>
  Effect.fn("Email.send")(function* (
    input: MessageInput | MessageDraft,
    options: SendOptions = {}
  ): Effect.fn.Return<SubmissionReceipt, EmailError> {
    const selectedRoute = options.route ?? defaultRoute
    const transport = routes.get(selectedRoute)
    if (transport === undefined) {
      return yield* new UnsupportedCapability({
        message: `unknown email route: ${selectedRoute}`,
        capability: "route"
      })
    }

    const prepared = yield* prepare(input, {
      from: defaultFrom,
      deliveryId: options.deliveryId ?? newDeliveryId()
    })
    const message = yield* renderIfNeeded(prepared, renderer)

    yield* checkCapabilities(transport, message)

    yield* Effect.annotateCurrentSpan({
      route: selectedRoute,
      provider: transport.destination.provider,
      deliveryId: message.deliveryId
    })

    const envelope = makeEnvelope(
      message,
      selectedRoute,
      transport,
      options.providerIdempotencyKey
    )
    const receipt = yield* transport.send(envelope)

    return finalizeReceipt(receipt, envelope)
  })

type BatchSlot =
  | {
      readonly _tag: "Invalid"
      readonly index: number
      readonly error: EmailError
    }
  | {
      readonly _tag: "Ready"
      readonly index: number
      readonly envelope: PreparedEnvelope
    }

type ReadySlot = Extract<BatchSlot, { readonly _tag: "Ready" }>

const failureOutcome = (index: number, error: EmailError): MessageOutcome =>
  certaintyOf(error) === "unknown"
    ? { _tag: "uncertain", index, error }
    : { _tag: "rejected", index, error }

const missingOutcome = (
  index: number,
  provider: string
): MessageOutcome => ({
  _tag: "uncertain",
  index,
  error: new DeliveryUncertain({
    message: "provider batch response omitted this message",
    provider
  })
})

const executeNativeBatch = (
  transport: NativeBatchTransport,
  slots: ReadonlyArray<ReadySlot>,
  concurrency: number
): Effect.Effect<ReadonlyArray<MessageOutcome>> => {
  const maxBatchSize = Math.max(
    1,
    Math.min(transport.capabilities.maxBatchSize ?? slots.length, slots.length)
  )
  const chunks: Array<ReadonlyArray<ReadySlot>> = []
  for (let offset = 0; offset < slots.length; offset += maxBatchSize) {
    chunks.push(slots.slice(offset, offset + maxBatchSize))
  }

  return Effect.forEach(
    chunks,
    (chunk): Effect.Effect<ReadonlyArray<MessageOutcome>> =>
      Effect.result(
        transport.sendBatch(chunk.map((slot) => slot.envelope))
      ).pipe(
        Effect.map((result) => {
          if (Result.isFailure(result)) {
            return chunk.map((slot) =>
              failureOutcome(slot.index, result.failure)
            )
          }
          const byOriginalIndex = new Map<number, MessageOutcome>()
          for (const outcome of result.success) {
            if (
              !Number.isInteger(outcome.index) ||
              outcome.index < 0 ||
              outcome.index >= chunk.length
            ) {
              continue
            }
            const slot = chunk[outcome.index]!
            if (!byOriginalIndex.has(slot.index)) {
              byOriginalIndex.set(
                slot.index,
                outcome._tag === "accepted"
                  ? {
                      ...outcome,
                      index: slot.index,
                      receipt: finalizeReceipt(
                        outcome.receipt,
                        slot.envelope
                      )
                    }
                  : { ...outcome, index: slot.index }
              )
            }
          }
          return chunk.map(
            (slot) =>
              byOriginalIndex.get(slot.index) ??
              missingOutcome(slot.index, transport.destination.provider)
          )
        })
      ),
    { concurrency }
  ).pipe(Effect.map((groups) => groups.flat()))
}

const makeSendBatch = (
  defaultFrom: NormalizedAddress,
  defaultRoute: RouteName,
  routes: ReadonlyMap<string, Transport>,
  renderer: RendererShape | undefined
): EmailShape["sendBatch"] =>
  Effect.fn("Email.sendBatch")(function* (
    inputs: ReadonlyArray<MessageInput | MessageDraft>,
    options: BatchOptions = {}
  ): Effect.fn.Return<ReadonlyArray<MessageOutcome>, BatchExecutionError> {
    const selectedRoute = options.route ?? defaultRoute
    const transport = routes.get(selectedRoute)
    if (transport === undefined) {
      return yield* new BatchExecutionError({
        message: `unknown email route: ${selectedRoute}`
      })
    }

    const concurrency = options.concurrency ?? 4
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      return yield* new BatchExecutionError({
        message: "batch concurrency must be a positive integer"
      })
    }

    const perMessageKey = (deliveryId: string): string | undefined =>
      options.providerIdempotencyKey === undefined
        ? undefined
        : isNativeBatchTransport(transport)
          ? options.providerIdempotencyKey
          : `${options.providerIdempotencyKey}:${deliveryId}`

    const slots = yield* Effect.forEach(
      inputs,
      (input, index): Effect.Effect<BatchSlot> =>
        Effect.gen(function* () {
          const prepared = yield* Effect.result(
            prepare(input, {
              from: defaultFrom,
              deliveryId: newDeliveryId()
            })
          )
          if (Result.isFailure(prepared)) {
            return {
              _tag: "Invalid" as const,
              index,
              error: prepared.failure
            }
          }
          const rendered = yield* Effect.result(
            renderIfNeeded(prepared.success, renderer)
          )
          if (Result.isFailure(rendered)) {
            return {
              _tag: "Invalid" as const,
              index,
              error: rendered.failure
            }
          }
          const checked = yield* Effect.result(
            checkCapabilities(transport, rendered.success)
          )
          if (Result.isFailure(checked)) {
            return {
              _tag: "Invalid" as const,
              index,
              error: checked.failure
            }
          }
          return {
            _tag: "Ready" as const,
            index,
            envelope: makeEnvelope(
              rendered.success,
              selectedRoute,
              transport,
              perMessageKey(rendered.success.deliveryId!)
            )
          }
        })
    )

    const invalidOutcomes = slots
      .filter(
        (slot): slot is Extract<BatchSlot, { readonly _tag: "Invalid" }> =>
          slot._tag === "Invalid"
      )
      .map((slot): MessageOutcome => ({
        _tag: "invalid",
        index: slot.index,
        error: slot.error
      }))
    const ready = slots.filter(
      (slot): slot is ReadySlot => slot._tag === "Ready"
    )

    const executed: ReadonlyArray<MessageOutcome> =
      ready.length === 0
        ? []
        : isNativeBatchTransport(transport)
          ? yield* executeNativeBatch(transport, ready, concurrency)
          : yield* Effect.forEach(
              ready,
              (slot): Effect.Effect<MessageOutcome> =>
                Effect.result(transport.send(slot.envelope)).pipe(
                  Effect.map((result) =>
                    Result.isFailure(result)
                      ? failureOutcome(slot.index, result.failure)
                      : {
                          _tag: "accepted" as const,
                          index: slot.index,
                          receipt: finalizeReceipt(
                            result.success,
                            slot.envelope
                          )
                        }
                  )
                ),
              { concurrency }
            )

    return [...invalidOutcomes, ...executed].sort(
      (left, right) => left.index - right.index
    )
  })

const makeSendStream = (
  sendBatch: EmailShape["sendBatch"]
): EmailShape["sendStream"] =>
  (inputs, options = {}) => {
    const chunkSize = options.chunkSize ?? 32
    const concurrency = options.concurrency ?? 4
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      return Stream.fail(
        new BatchExecutionError({
          message: "stream chunk size must be a positive integer"
        })
      )
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      return Stream.fail(
        new BatchExecutionError({
          message: "batch concurrency must be a positive integer"
        })
      )
    }
    return inputs.pipe(
      Stream.grouped(chunkSize),
      Stream.mapEffect(
        (chunk, chunkIndex) =>
          sendBatch(chunk, options).pipe(
            Effect.map((outcomes) =>
              outcomes.map((outcome) => ({
                ...outcome,
                index: outcome.index + chunkIndex * chunkSize
              }))
            )
          ),
        { concurrency }
      ),
      Stream.flattenIterable
    )
  }

export const layer = Email.layer
export const layerValidated = Email.layerValidated
export const layerFromRegistry = Email.layerFromRegistry
export const layerFromRegistryLayer = Email.layerFromRegistryLayer
export const layerTransport = Email.layerTransport

export const send = (
  input: MessageInput | MessageDraft,
  options?: SendOptions
): Effect.Effect<SubmissionReceipt, EmailError, Email> =>
  Effect.flatMap(Email, (email) => email.send(input, options))

export const retrieve = (
  receipt: SubmissionReceipt
): Effect.Effect<DeliveryStatus, EmailError, Email> =>
  Effect.flatMap(Email, (email) => email.retrieve(receipt))

export const cancel = (
  receipt: SubmissionReceipt
): Effect.Effect<void, EmailError, Email> =>
  Effect.flatMap(Email, (email) => email.cancel(receipt))

export const sendBatch = (
  inputs: ReadonlyArray<MessageInput | MessageDraft>,
  options?: BatchOptions
): Effect.Effect<ReadonlyArray<MessageOutcome>, BatchExecutionError, Email> =>
  Effect.flatMap(Email, (email) => email.sendBatch(inputs, options))

export const sendStream = (
  inputs: Stream.Stream<MessageInput | MessageDraft>,
  options?: StreamOptions
): Stream.Stream<MessageOutcome, BatchExecutionError, Email> =>
  Stream.fromEffect(Email).pipe(
    Stream.flatMap((email) => email.sendStream(inputs, options))
  )


