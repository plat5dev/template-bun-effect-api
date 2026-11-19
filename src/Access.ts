/**
 * Identity access evaluation (`POST {IDENTITY_INTERNAL_URL}/access/v1/evaluation`).
 * Fails closed (`NoAnswer`) on any non-200 response, malformed body, timeout, or unset URL.
 */
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpBody, HttpClient, HttpIncomingMessage } from "effect/http"
import { AppConfig } from "./Config.js"
import { currentRequestId } from "./plat5/Errors.js"

export type Question = {
  readonly memberId: string
  readonly kind: string
  readonly nodeId: string
  readonly permission: string
}

export class NoAnswer extends Schema.TaggedError<NoAnswer>()("NoAnswer", { message: Schema.String }) {}

const Answer = Schema.Struct({ decision: Schema.Boolean })

export class Access extends Context.Service<Access>()("api/Access", {
  make: Effect.gen(function*() {
    const config = yield* AppConfig
    const baseUrl = config.identityInternalUrl?.replace(/\/+$/, "") || undefined
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatus((status) => status === 200)
    )

    const ask = (q: Question, requestId: string | null) =>
      baseUrl === undefined
        ? Effect.fail(new NoAnswer({ message: "IDENTITY_INTERNAL_URL is unset" }))
        : client.post(`${baseUrl}/access/v1/evaluation`, {
          headers: requestId === null ? {} : { "x-request-id": requestId },
          body: HttpBody.jsonUnsafe({
            subject: { type: "member", id: q.memberId },
            resource: { type: q.kind, id: q.nodeId },
            action: { name: q.permission }
          })
        }).pipe(
          Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Answer)),
          Effect.timeout(Duration.seconds(10)),
          Effect.map((answer) => answer.decision),
          Effect.mapError((err) => new NoAnswer({ message: err.message }))
        )

    const evaluate = Effect.fnUntraced(function*(question: Question) {
      const requestId = yield* currentRequestId
      return yield* ask(question, requestId).pipe(
        Effect.tapError((err) =>
          Effect.logError("access evaluation failed").pipe(
            Effect.annotateLogs({ component: "access", error_message: err.message })
          )
        )
      )
    })

    return { evaluate } as const
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}
