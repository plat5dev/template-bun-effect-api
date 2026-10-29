import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit } from "effect"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { AppConfig } from "./AppConfig.js"

const missing =
  "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"

/** The config, read from `env` alone. */
const load = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    AppConfig.pipe(
      Effect.provide(AppConfig.Live),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))))
    )
  )

test("TASK_ASSIGNEE_PERMISSION unset or not a permission name: the config fails", async () => {
  for (const env of [
    {},
    { TASK_ASSIGNEE_PERMISSION: "" },
    { TASK_ASSIGNEE_PERMISSION: "  " },
    { TASK_ASSIGNEE_PERMISSION: " tasks:assignable " },
    { TASK_ASSIGNEE_PERMISSION: "Project:Read" },
    { TASK_ASSIGNEE_PERMISSION: "a".repeat(65) }
  ] as Record<string, string>[]) {
    const exit = await load(env)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain(missing)
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", async () => {
  const exit = await load({ TASK_ASSIGNEE_PERMISSION: "tasks:assignable" })
  expect(Exit.isSuccess(exit) && exit.value.taskAssigneePermission).toBe("tasks:assignable")
})

test("variables are read as set: only unset or empty is unset", async () => {
  const exit = await load({
    TASK_ASSIGNEE_PERMISSION: "tasks:assignable",
    IDENTITY_INTERNAL_URL: "",
    DATABASE_PATH: ""
  })
  if (!Exit.isSuccess(exit)) throw new Error(String(exit))
  expect(exit.value.taskAssigneePermission).toBe("tasks:assignable")
  expect(exit.value.identityInternalUrl).toBeUndefined()
  expect(exit.value.databasePath).toBe("./data/app.db")
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
