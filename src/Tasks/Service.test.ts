import { SqlClient } from "@effect/sql"
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { Access } from "../Access.js"
import { AppConfig } from "../AppConfig.js"
import { TaskId } from "../domain/Task.js"
import { SqlLive } from "../Sql.js"
import { TasksRepo } from "./Repo.js"
import { Tasks } from "./Service.js"

const environment = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const member = "01jd8x3k7q00000000000000mm"
const from = { projectId: undefined, requestId: "" }

/** A repo whose reads find the task, and then it's deleted: a delete between read and write. */
const RacyRepoLive = Layer.effect(
  TasksRepo,
  Effect.gen(function*() {
    const real = yield* TasksRepo
    const sql = yield* SqlClient.SqlClient
    return TasksRepo.make({
      ...real,
      findInEnvironment: (environmentId, id) =>
        real.findInEnvironment(environmentId, id).pipe(
          Effect.tap(() => sql`DELETE FROM tasks WHERE id = ${id}`.pipe(Effect.orDie))
        )
    })
  })
).pipe(Layer.provide(TasksRepo.Default))

const run = <A, E>(effect: Effect.Effect<A, E, Tasks | TasksRepo>, racy = false) =>
  Effect.runPromise(
    Effect.either(effect).pipe(
      Effect.provide(
        Layer.mergeAll(
          Tasks.DefaultWithoutDependencies.pipe(
            Layer.provide(racy ? RacyRepoLive : TasksRepo.Default),
            Layer.provide(Access.Default),
            Layer.provide(AppConfig.Live)
          ),
          TasksRepo.Default
        ).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.Live))
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", "x"]]))
      )
    )
  )

test("PATCH and DELETE answer 404 when the scoped write finds no row", async () => {
  const result = await run(
    Effect.gen(function*() {
      const tasks = yield* Tasks
      const a = yield* tasks.create(environment, member, { title: "Launch" }, from)
      const b = yield* tasks.create(environment, member, { title: "Land" }, from)
      return [
        yield* Effect.flip(tasks.update(environment, a.id, { status: "done" }, from)),
        yield* Effect.flip(tasks.remove(environment, b.id))
      ]
    }),
    true
  )
  if (result._tag === "Left") throw new Error(JSON.stringify(result.left))
  for (const error of result.right) {
    expect(error).toMatchObject({ error: { code: "NOT_FOUND", details: { resource: "task" } } })
  }
})

test("the repo's writes are scoped by the environment", async () => {
  const result = await run(
    Effect.gen(function*() {
      const tasks = yield* Tasks
      const repo = yield* TasksRepo
      const task = yield* tasks.create(other, member, { title: "Elsewhere" }, from)
      const id = TaskId.make(task.id)
      const updated = yield* repo.updateInEnvironment({ ...task, environment_id: environment, title: "Moved" })
      const deleted = yield* repo.deleteInEnvironment(environment, id)
      const after = yield* repo.findInEnvironment(other, id)
      return { updated, deleted, title: after?.title }
    })
  )
  if (result._tag === "Left") throw new Error(JSON.stringify(result.left))
  expect(result.right).toEqual({ updated: undefined, deleted: false, title: "Elsewhere" })
})
