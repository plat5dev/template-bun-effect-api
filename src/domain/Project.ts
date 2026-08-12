import { Model } from "@effect/sql"
import { Schema } from "effect"

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type

export class Project extends Model.Class<Project>("Project")({
  id: Model.GeneratedByApp(ProjectId),
  organization_id: Model.GeneratedByApp(Schema.String),
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  description: Schema.String.pipe(Schema.maxLength(2000)),
  created_by_member_id: Model.GeneratedByApp(Schema.String),
  created_at: Model.GeneratedByApp(Schema.String),
  updated_at: Model.GeneratedByApp(Schema.String)
}) {}
