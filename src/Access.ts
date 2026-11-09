/**
 * Asks identity whether a member holds a permission on a node, for a member who isn't the
 * caller (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request).
 *
 * Each question is one evaluation on identity's internal port (plat5
 * docs/reference/api/internal.md#access-evaluation). Only a 200 with a boolean `decision`
 * is an answer. Anything else is `NoAnswer`, logged with the request id, and no answer is no.
 */
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpIncomingMessage } from "effect/http"
import { AppConfig } from "./AppConfig.js"
import { currentRequestId } from "./plat5/RequestId.js"

/** Whether the member `memberId` holds `permission` on the node `nodeId` of kind `kind`. */
export type Question = {
  readonly memberId: string
  readonly kind: string
  readonly nodeId: string
  readonly permission: string
}

/** Identity gave no answer: anything but a 200 with a boolean `decision`. */
export class NoAnswer extends Schema.TaggedError<NoAnswer>()("NoAnswer", { message: Schema.String }) {}

const Answer = Schema.Struct({ decision: Schema.Boolean })

export class Access extends Context.Service<Access>()("api/Access", {
  make: Effect.gen(function*() {
    const config = yield* AppConfig
    // Each call is a client span, its trace going on to identity as traceparent.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatus((status) => status === 200)
    )

    const ask = (q: Question, requestId: string | null) =>
      config.identityInternalUrl === undefined
        ? Effect.fail(new NoAnswer({ message: "IDENTITY_INTERNAL_URL is unset" }))
        : client.post(`${config.identityInternalUrl}/access/v1/evaluation`, {
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

    /**
     * Identity's decision. The current request's `X-Request-ID` goes to identity with it, and
     * is logged with a failure.
     */
    const evaluate = Effect.fnUntraced(function*(question: Question) {
      const requestId = yield* currentRequestId
      return yield* ask(question, requestId).pipe(
        Effect.tapError((err) =>
          Effect.logError("access evaluation failed").pipe(
            Effect.annotateLogs({ component: "access", request_id: requestId ?? "", error_message: err.message })
          )
        )
      )
    })

    return { evaluate } as const
  })
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide([AppConfig.layer, FetchHttpClient.layer])
  )
}
