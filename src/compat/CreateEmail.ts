import { Effect } from "effect"
import * as Email from "../Email"
import type { EmailError } from "../EmailError"
import type { RouteName } from "../Ids"
import type { MailboxInput, MessageDraft, MessageInput } from "../Message"
import type { Transport } from "../EmailTransport"
import type { RendererShape } from "../render/Template"
import type {
  MessageOutcome,
  SubmissionReceipt
} from "../Submission"

export interface CompatResult<T> {
  readonly data?: T
  readonly error?: EmailError
}

export interface CompatBatchResult {
  readonly results: ReadonlyArray<MessageOutcome>
}

export interface CreateEmailOptions {
  readonly transport: Transport
  readonly defaultFrom: MailboxInput
  readonly renderer?: RendererShape
  readonly route?: RouteName
}

export interface EmailFacade {
  readonly send: (
    message: MessageInput | MessageDraft
  ) => Promise<CompatResult<SubmissionReceipt>>
  readonly sendBatch: (
    messages: ReadonlyArray<MessageInput | MessageDraft>
  ) => Promise<CompatBatchResult>
  readonly sendStream: (
    messages: Iterable<MessageInput | MessageDraft>,
    options?: { readonly chunkSize?: number }
  ) => AsyncIterable<CompatResult<SubmissionReceipt>>
  readonly isAvailable: () => Promise<boolean>
  readonly dispose: () => Promise<void>
}

export const createEmail = (
  options: CreateEmailOptions
): EmailFacade => {
  const layer = Email.layer({
    defaultFrom: options.defaultFrom,
    ...(options.route === undefined
      ? {}
      : { defaultRoute: options.route }),
    routes: { [options.route ?? "default"]: options.transport },
    ...(options.renderer === undefined
      ? {}
      : { renderer: options.renderer })
  })

  const send: EmailFacade["send"] = async (message) => {
    const result = await Effect.runPromise(
      Effect.result(Email.send(message).pipe(Effect.provide(layer)))
    )
    return result._tag === "Success"
      ? { data: result.success }
      : { error: result.failure }
  }

  const sendBatch: EmailFacade["sendBatch"] = async (messages) => {
    const results = await Effect.runPromise(
      Email.sendBatch(messages).pipe(Effect.provide(layer))
    )
    return { results }
  }

  const sendStream: EmailFacade["sendStream"] = (
    messages,
    streamOptions = {}
  ) => ({
    async *[Symbol.asyncIterator]() {
      const chunkSize = Math.max(1, streamOptions.chunkSize ?? 50)
      let chunk: Array<MessageInput | MessageDraft> = []
      for (const message of messages) {
        chunk.push(message)
        if (chunk.length < chunkSize) continue
        const batch = await sendBatch(chunk)
        for (const outcome of batch.results) {
          yield outcome._tag === "accepted"
            ? { data: outcome.receipt }
            : { error: outcome.error }
        }
        chunk = []
      }
      if (chunk.length > 0) {
        const batch = await sendBatch(chunk)
        for (const outcome of batch.results) {
          yield outcome._tag === "accepted"
            ? { data: outcome.receipt }
            : { error: outcome.error }
        }
      }
    }
  })

  return {
    send,
    sendBatch,
    sendStream,
    isAvailable: async () => true,
    dispose: async () => undefined
  }
}
