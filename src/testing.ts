import { ConfigProvider, type Layer } from "effect"

/** The config read from `env` alone, as the environment would set it: for tests. */
export const envLayer = (env: ReadonlyMap<string, string> | Readonly<Record<string, string>>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env instanceof Map ? Object.fromEntries(env) : env))
