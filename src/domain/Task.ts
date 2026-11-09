import { Schema } from "effect"
import { Model } from "effect/schema"
import { Ulid } from "../plat5/Ids.js"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literals(["todo", "in_progress", "done"]).annotate({
  message: "Status must be todo, in progress, or done."
})
export type TaskStatus = typeof TaskStatus.Type

// Authored data: created_by is the member who made it, and stays theirs if they leave
// the tree (plat5 docs/concepts/model.md#where-a-field-goes). assignee_id is a member in
// the same tree, or null. The model sets created_at on insert and updated_at on every write.
export class Task extends Model.Class<Task>("Task")({
  id: Model.GeneratedByApp(TaskId),
  project_id: Model.GeneratedByApp(Schema.String),
  title: Schema.String,
  status: TaskStatus,
  assignee_id: Schema.NullOr(Schema.String),
  created_by: Model.GeneratedByApp(Schema.String),
  created_at: Model.DateTimeInsert,
  updated_at: Model.DateTimeUpdate
}) {}

/** A title as sent: trimmed of white space, then 1 to 255 characters. */
const Title = Schema.Trim.check(
  Schema.isMinCodePoints(1, { message: "Title is required." }),
  Schema.isMaxCodePoints(255, { message: "Title is too long." })
).annotate({ description: "Trimmed of white space, then 1 to 255 characters." })

/** A member id in the project's tree who can see the project, or null for none. */
const AssigneeId = Schema.NullOr(Ulid).annotate({
  description: "A member id in the project's tree who can see the project, or null for none."
})

/** A create's body. Without a status, a task is `todo`; without an assignee, it has none. */
export const TaskCreate = Schema.Struct({
  title: Title.pipe(Schema.annotateKey({ messageMissingKey: "Title is required." })),
  status: Schema.optionalKey(TaskStatus),
  assignee_id: Schema.optionalKey(AssigneeId)
})
export type TaskCreate = typeof TaskCreate.Type

/** An update's body. A field absent or null leaves the task's as it is, but for assignee_id: null unassigns. */
export const TaskUpdate = Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Title)),
  status: Schema.optionalKey(Schema.NullOr(TaskStatus)),
  assignee_id: Schema.optionalKey(AssigneeId)
})
export type TaskUpdate = typeof TaskUpdate.Type
