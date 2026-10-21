import { pgTable, uuid, jsonb } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Rebuildable read projection; never authority for admission or ownership.
export const heartbeatRunListContext = pgTable("heartbeat_run_list_context", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull(),
});
