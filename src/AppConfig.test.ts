import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit } from "effect"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { AppConfig } from "./AppConfig.js"

const missing =
  "TASK_ASSIGNEE_PERMISSION is unset or empty: set it to the permission an assignee needs on the task's project (the starter's is project:read)"

/** The config, read from `env` alone. */
const load = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    AppConfig.pipe(
      Effect.provide(AppConfig.Live),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))))
    )
  )

test("TASK_ASSIGNEE_PERMISSION unset or empty: the config fails", async () => {
  for (const env of [{}, { TASK_ASSIGNEE_PERMISSION: "" }, { TASK_ASSIGNEE_PERMISSION: "  " }] as Record<string, string>[]) {
    const exit = await load(env)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain(missing)
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", async () => {
  const exit = await load({ TASK_ASSIGNEE_PERMISSION: "tasks:assignable" })
  expect(Exit.isSuccess(exit) && exit.value.taskAssigneePermission).toBe("tasks:assignable")
})

test("without TASK_ASSIGNEE_PERMISSION the API won't start", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url))
  // Out of the repo, so no .env sets it.
  const run = Bun.spawnSync([process.execPath, main], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", TASK_ASSIGNEE_PERMISSION: "" }
  })
  expect(run.exitCode).toBe(1)
  expect(`${run.stdout}${run.stderr}`).toContain(missing)
})
