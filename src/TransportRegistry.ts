import { Context, Effect, Layer } from "effect"
import type { RouteName } from "./Ids"
import { routeName } from "./Ids"
import type { Transport } from "./EmailTransport"
import { UnsupportedCapability } from "./EmailError"

export interface TransportRegistryShape {
  readonly defaultRoute: RouteName | undefined
  readonly routes: Effect.Effect<ReadonlyArray<RouteName>>
  readonly get: (
    route: RouteName
  ) => Effect.Effect<Transport, UnsupportedCapability>
}

export class TransportRegistry extends Context.Service<
  TransportRegistry,
  TransportRegistryShape
>()("@effect-email/TransportRegistry") {}

const resolveDefault = (
  names: ReadonlyArray<string>,
  requested: RouteName | undefined
): RouteName | undefined => {
  if (requested !== undefined) {
    return names.includes(requested) ? requested : undefined
  }
  if (names.includes("default")) {
    return routeName("default")
  }
  return names.length === 1 ? routeName(names[0]!) : undefined
}

export const make = (
  routes: Readonly<Record<string, Transport>>,
  options: { readonly defaultRoute?: RouteName } = {}
): Effect.Effect<TransportRegistryShape, never> =>
  Effect.sync(() => {
    const entries = Object.entries(routes)
    if (entries.length === 0) {
      throw new Error("TransportRegistry requires at least one route")
    }
    const byName = new Map(entries)
    const names = entries.map(([name]) => name)
    const defaultRoute = resolveDefault(names, options.defaultRoute)
    if (options.defaultRoute !== undefined && defaultRoute === undefined) {
      throw new Error(`default route not found: ${options.defaultRoute}`)
    }
    return {
      defaultRoute,
      routes: Effect.succeed(names.map(routeName)),
      get: (route) => {
        const transport = byName.get(route)
        return transport === undefined
          ? Effect.fail(
              new UnsupportedCapability({
                message: `unknown email route: ${route}`,
                capability: "route"
              })
            )
          : Effect.succeed(transport)
      }
    }
  })

export const layer = (
  routes: Readonly<Record<string, Transport>>,
  options: { readonly defaultRoute?: RouteName } = {}
): Layer.Layer<TransportRegistry> =>
  Layer.effect(TransportRegistry, make(routes, options))

export const get = (
  route: RouteName
): Effect.Effect<Transport, UnsupportedCapability, TransportRegistry> =>
  Effect.flatMap(TransportRegistry, (registry) => registry.get(route))

export const routes: Effect.Effect<
  ReadonlyArray<RouteName>,
  never,
  TransportRegistry
> = Effect.flatMap(TransportRegistry, (registry) => registry.routes)

export const defaultRoute: Effect.Effect<
  RouteName | undefined,
  never,
  TransportRegistry
> = Effect.map(TransportRegistry, (registry) => registry.defaultRoute)