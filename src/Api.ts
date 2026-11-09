import { HttpApi, OpenApi } from "effect/http-api"
import { parseOptions } from "./plat5/Request.js"
import { ProfilesApi } from "./Profiles/Api.js"
import { TasksApi } from "./Tasks/Api.js"

export class Api extends HttpApi.make("api")
  .add(ProfilesApi)
  .add(TasksApi)
  // Every issue in a request, a body's unknown keys among them (src/plat5/Request.ts).
  .annotate(HttpApi.PayloadParseOptions, parseOptions.payload)
  .annotate(HttpApi.QueryParseOptions, parseOptions.query)
  .annotateMerge(OpenApi.annotations({
    title: "Plat5 API",
    description: "Reference Bun + Effect business service for Plat5"
  }))
{}
