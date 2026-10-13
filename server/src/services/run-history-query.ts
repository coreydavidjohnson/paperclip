import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// Task run membership: the first-class issue binding OR company-scoped issue
// activity. A UNION of two indexed lookups replaces the correlated OR-EXISTS,
// which forced a scan of every company run. IN removes duplicates.
export function issueRunIdsCondition(companyId: string, issueId: string) {
  return sql`${heartbeatRuns.id} in (
    select id from heartbeat_runs
    where company_id = ${companyId} and issue_id = ${issueId}
    union
    select run_id from activity_log
    where company_id = ${companyId} and entity_type = 'issue'
      and entity_id = ${issueId} and run_id is not null
  )`;
}
