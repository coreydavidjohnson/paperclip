import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Post-commit effects of a run ending (PER-966). One row per dedupe key; consumers are idempotent. */
export const runLivenessOutbox = pgTable(
  "run_liveness_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    runId: uuid("run_id"),
    action: text("action").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index("run_liveness_outbox_pending_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  }),
);
