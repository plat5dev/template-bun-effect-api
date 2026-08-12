import { Model } from "@effect/sql"
import { Schema } from "effect"
import { ProjectId } from "./Project.js"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literal("todo", "in_progress", "done")
export type TaskStatus = typeof TaskStatus.Type

export class Task extends Model.Class<Task>("Task")({
  id: Model.GeneratedByApp(TaskId),
  organization_id: Model.GeneratedByApp(Schema.String),
  project_id: Model.GeneratedByApp(ProjectId),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  status: TaskStatus,
  created_by_member_id: Model.GeneratedByApp(Schema.String),
  created_at: Model.GeneratedByApp(Schema.String),
  updated_at: Model.GeneratedByApp(Schema.String)
}) {}
