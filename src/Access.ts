/**
 * Asks identity whether a member holds a permission on a node, for a member who isn't the
 * caller (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request).
 *
 * Each question is one evaluation on identity's internal port (plat5
 * docs/reference/api/internal.md#access-evaluation). Only a 200 with a boolean `decision`
 * is an answer. Anything else is `NoAnswer`, logged with the request id, and no answer is no.
 */
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "@effect/platform"
import { Data, Duration, Effect, Schema } from "effect"
import { AppConfig } from "./AppConfig.js"

/** Whether the member `memberId` holds `permission` on the node `nodeId` of kind `kind`. */
export type Question = {
  readonly memberId: string
  readonly kind: string
  readonly nodeId: string
  readonly permission: string
}

/** Identity gave no answer: anything but a 200 with a boolean `decision`. */
export class NoAnswer extends Data.TaggedError("NoAnswer")<{ readonly message: string }> {}

const Answer = Schema.Struct({ decision: Schema.Boolean })

export class Access extends Effect.Service<Access>()("Access", {
  effect: Effect.gen(function*() {
    const config = yield* AppConfig
    // Traced, so the request's trace goes on to identity as traceparent.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatus((status) => status === 200)
    )

    const ask = (q: Question, requestId: string) =>
      config.identityInternalUrl === undefined
        ? Effect.fail(new NoAnswer({ message: "IDENTITY_INTERNAL_URL is unset" }))
        : client.post(`${config.identityInternalUrl}/access/v1/evaluation`, {
          headers: { "x-request-id": requestId },
          body: HttpBody.unsafeJson({
            subject: { type: "member", id: q.memberId },
            resource: { type: q.kind, id: q.nodeId },
            action: { name: q.permission }
          })
        }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Answer)),
          Effect.scoped,
          Effect.timeout(Duration.seconds(10)),
          Effect.map((answer) => answer.decision),
          Effect.mapError((err) => new NoAnswer({ message: err.message }))
        )

    /**
     * Identity's decision. `requestId` is the request's `X-Request-ID`: sent to identity,
     * and logged with a failure.
     */
    const evaluate = (question: Question, requestId: string): Effect.Effect<boolean, NoAnswer> =>
      ask(question, requestId).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            console.log(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                message: "access evaluation failed",
                component: "access",
                request_id: requestId,
                error_message: err.message
              })
            )
          )
        )
      )

    return { evaluate } as const
  }),
  dependencies: [AppConfig.Live, FetchHttpClient.layer]
}) {}
