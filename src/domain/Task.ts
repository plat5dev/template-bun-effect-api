import { Model } from "@effect/sql"
import { Schema } from "effect"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literal("todo", "in_progress", "done")
export type TaskStatus = typeof TaskStatus.Type

// Authored data: created_by is the member who made it, and stays theirs if they leave
// the tree (plat5 docs/concepts/model.md#where-a-field-goes).
export class Task extends Model.Class<Task>("Task")({
  id: Model.GeneratedByApp(TaskId),
  environment_id: Model.GeneratedByApp(Schema.String),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  status: TaskStatus,
  created_by: Model.GeneratedByApp(Schema.String),
  created_at: Model.GeneratedByApp(Schema.String),
  updated_at: Model.GeneratedByApp(Schema.String)
}) {}
