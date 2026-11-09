import { SqlClient } from "effect/sql"
import { expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Access } from "../Access.js"
import { AppConfig } from "../AppConfig.js"
import { Task, TaskId } from "../domain/Task.js"
import { SqlLive } from "../Sql.js"
import { TasksRepo } from "./Repo.js"
import { Tasks } from "./Service.js"
import { envLayer } from "../testing.js"

const project = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const member = "01jd8x3k7q00000000000000mm"

/** A repo whose reads find the task, and then it's deleted: a delete between read and write. */
const RacyRepoLive = Layer.effect(
  TasksRepo,
  Effect.gen(function*() {
    const real = yield* TasksRepo
    const sql = yield* SqlClient.SqlClient
    return TasksRepo.of({
      ...real,
      findInProject: (projectId, id) =>
        real.findInProject(projectId, id).pipe(
          Effect.tap(() => sql`DELETE FROM tasks WHERE id = ${id}`.pipe(Effect.orDie))
        )
    })
  })
).pipe(Layer.provide(TasksRepo.layer))

const run = <A, E>(effect: Effect.Effect<A, E, Tasks | TasksRepo>, racy = false) =>
  Effect.runPromise(
    Effect.result(effect).pipe(
      Effect.provide(
        Layer.mergeAll(
          Tasks.layerNoDeps.pipe(
            Layer.provide(racy ? RacyRepoLive : TasksRepo.layer),
            Layer.provide(Access.layer),
            Layer.provide(AppConfig.layer)
          ),
          TasksRepo.layer
        ).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.layer))
      ),
      Effect.provide(envLayer(new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", "x"]]))
      )
    )
  )

test("PATCH and DELETE answer 404 when the scoped write finds no row", async () => {
  const result = await run(
    Effect.gen(function*() {
      const tasks = yield* Tasks
      const a = yield* tasks.create(project, member, { title: "Launch" })
      const b = yield* tasks.create(project, member, { title: "Land" })
      return [
        yield* Effect.flip(tasks.update(project, a.id, { status: "done" })),
        yield* Effect.flip(tasks.remove(project, b.id))
      ]
    }),
    true
  )
  if (result._tag === "Failure") throw new Error(JSON.stringify(result.failure))
  for (const error of result.success) {
    expect(error).toMatchObject({ _tag: "NotFound", resource: "task" })
  }
})

test("the repo's writes are scoped by the project", async () => {
  const result = await run(
    Effect.gen(function*() {
      const tasks = yield* Tasks
      const repo = yield* TasksRepo
      const task = yield* tasks.create(other, member, { title: "Elsewhere" })
      const id = TaskId.make(task.id)
      const moved = yield* Task.update.makeEffect({
        id: task.id,
        project_id: project,
        title: "Moved",
        status: task.status,
        assignee_id: task.assignee_id,
        created_by: task.created_by
      }).pipe(Effect.orDie)
      const updated = yield* repo.updateInProject(moved)
      const deleted = yield* repo.deleteInProject(project, id)
      const after = yield* repo.findInProject(other, id)
      return { updated: Option.getOrUndefined(updated), deleted, title: Option.getOrUndefined(after)?.title }
    })
  )
  if (result._tag === "Failure") throw new Error(JSON.stringify(result.failure))
  expect(result.success).toEqual({ updated: undefined, deleted: false, title: "Elsewhere" })
})
