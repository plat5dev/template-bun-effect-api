import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"

/** The app's own settings. The telemetry variables are src/TelemetryConfig.ts's. */

/** `config`, or undefined when its variable is unset or empty. */
const optional = <A>(config: Config.Config<A>): Config.Config<A | undefined> =>
  Config.option(config).pipe(Config.map(Option.getOrUndefined))

/** A variable as set, untrimmed, or undefined when unset or empty. */
const text = (name: string) => optional(Config.String(name))

/** A permission's name as Plat5's roles write it. */
const PERMISSION_NAME = /^[a-z0-9:._-]{1,64}$/

/** A config failure with `message`, which names the variable. */
const invalid = (message: string) => new Config.ConfigError(new ConfigProvider.SourceError({ message }))

export class AppConfig extends Context.Service<AppConfig, {
  readonly port: number
  readonly internalPort: number
  readonly databasePath: string
  /**
   * Identity's internal base URL, for its lifecycle log and the assignee check.
   * Unset: the log isn't read, and a task with an assignee is a 503.
   */
  readonly identityInternalUrl: string | undefined
  /**
   * The permission a task's assignee needs on its project: the deployment's name for it,
   * never the code's. Unset or empty, the API won't start.
   */
  readonly taskAssigneePermission: string
}>()("api/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000))
      const internalPort = yield* Config.Int("INTERNAL_PORT").pipe(Config.withDefault(3001))
      const databasePath = (yield* text("DATABASE_PATH")) ?? "./data/app.db"
      const identityInternalUrl = yield* text("IDENTITY_INTERNAL_URL")
      const taskAssigneePermission = yield* text("TASK_ASSIGNEE_PERMISSION")
      if (taskAssigneePermission === undefined || !PERMISSION_NAME.test(taskAssigneePermission)) {
        return yield* Effect.fail(invalid(
          "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"
        ))
      }
      return AppConfig.of({ port, internalPort, databasePath, identityInternalUrl, taskAssigneePermission })
    })
  )
}
