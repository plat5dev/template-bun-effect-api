import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// The person's name is identity's directory name, not this service's.
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE profiles DROP COLUMN display_name`
})
