import { HttpApi, OpenApi } from "@effect/platform"
import { ProfilesApi } from "./Profiles/Api.js"
import { ProjectsApi } from "./Projects/Api.js"
import { TasksApi } from "./Tasks/Api.js"

export class Api extends HttpApi.make("api")
  .add(ProfilesApi)
  .add(ProjectsApi)
  .add(TasksApi)
  .annotate(OpenApi.Title, "Plat5 API")
  .annotate(OpenApi.Description, "Reference Bun + Effect business service for Plat5")
{}
