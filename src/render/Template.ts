import { Context, Effect, Layer, Schema } from "effect"
import { TemplateError } from "../EmailError"
import type { RenderedContent, TemplateContent } from "../Message"

export interface TemplateResult {
  readonly text?: string
  readonly html?: string
}

export interface TemplateDefinition<Props, R = never> {
  readonly id: string
  readonly version: string
  readonly props: Schema.Codec<Props, any>
  readonly render: (
    props: Props
  ) => Effect.Effect<TemplateResult, TemplateError, R>
}

export interface AnyTemplateDefinition<R = never> {
  readonly id: string
  readonly version: string
  readonly props: Schema.Codec<any, any>
  readonly render: (
    props: any
  ) => Effect.Effect<TemplateResult, TemplateError, R>
}

export interface RendererOptions {
  readonly textFallback?: boolean | ((html: string) => string)
}

const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
}

const decodeEntities = (value: string): string =>
  value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16)
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10)
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match
      }
      return entities[entity.toLowerCase()] ?? match
    }
  )

export const defaultHtmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export interface RendererShape {
  readonly render: (
    content: TemplateContent
  ) => Effect.Effect<RenderedContent, TemplateError>
}

export class Renderer extends Context.Service<Renderer, RendererShape>()(
  "@effect-email/render/Renderer"
) {}

const failure = (
  content: TemplateContent,
  message: string,
  cause?: unknown
): TemplateError =>
  new TemplateError({
    message,
    templateId: content.id,
    ...(content.version === undefined ? {} : { version: content.version }),
    ...(cause === undefined ? {} : { cause })
  })

export const make = <R = never>(
  definitions: ReadonlyArray<AnyTemplateDefinition<R>>,
  options: RendererOptions = {}
): Effect.Effect<RendererShape, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const textFallback =
      options.textFallback === true
        ? defaultHtmlToText
        : typeof options.textFallback === "function"
          ? options.textFallback
          : undefined
    const byId = new Map<string, Array<AnyTemplateDefinition<R>>>()
    for (const definition of definitions) {
      const existing = byId.get(definition.id) ?? []
      if (
        existing.some(
          (candidate) => candidate.version === definition.version
        )
      ) {
        return yield* Effect.die(
          new Error(
            `duplicate template ${definition.id}@${definition.version}`
          )
        )
      }
      existing.push(definition)
      byId.set(definition.id, existing)
    }

    const render = (
      content: TemplateContent
    ): Effect.Effect<RenderedContent, TemplateError> =>
      Effect.gen(function* () {
        const candidates = byId.get(content.id) ?? []
        if (candidates.length === 0) {
          return yield* failure(
            content,
            `template not found: ${content.id}`
          )
        }
        if (content.version === undefined && candidates.length > 1) {
          return yield* failure(
            content,
            `template version is required for ${content.id}`
          )
        }
        const definition =
          content.version === undefined
            ? candidates[0]!
            : candidates.find(
                (candidate) => candidate.version === content.version
              )
        if (definition === undefined) {
          return yield* failure(
            content,
            `template version not found: ${content.id}@${content.version}`
          )
        }
        const props = yield* Schema.decodeUnknownEffect(
          definition.props
        )(content.props ?? {}).pipe(
          Effect.mapError((cause) =>
            failure(content, "template props did not match schema", cause)
          )
        )
        const result = yield* definition.render(props).pipe(
          Effect.provide(context)
        )
        const text =
          result.text ??
          (result.html !== undefined && textFallback !== undefined
            ? textFallback(result.html)
            : undefined)
        if (text === undefined && result.html === undefined) {
          return yield* failure(
            content,
            `template ${content.id} rendered no content`
          )
        }
        return {
          _tag: "rendered",
          ...(text === undefined ? {} : { text }),
          ...(result.html === undefined ? {} : { html: result.html })
        }
      })

    return { render }
  })

export const layer = <R = never>(
  definitions: ReadonlyArray<AnyTemplateDefinition<R>>,
  options: RendererOptions = {}
): Layer.Layer<Renderer, never, R> =>
  Layer.effect(Renderer, make(definitions, options))

export const render = (
  content: TemplateContent
): Effect.Effect<RenderedContent, TemplateError, Renderer> =>
  Effect.flatMap(Renderer, (renderer) => renderer.render(content))
