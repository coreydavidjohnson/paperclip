import type { Issue } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { formatMonitorAbsolute, formatMonitorAbsoluteFull, timedIssueWait } from "../lib/issue-monitor";

export function TimedIssueWait({ issue, isLive = false }: { issue: Issue; isLive?: boolean }) {
  const wait = timedIssueWait(issue, isLive);
  if (!wait) return null;
  return (
    <span className="flex min-w-0 flex-col gap-1 break-words text-xs text-muted-foreground" data-testid="timed-issue-wait">
      <Badge variant="outline" className="whitespace-normal">
        <time dateTime={new Date(wait.nextCheckAt).toISOString()} title={formatMonitorAbsoluteFull(wait.nextCheckAt)}>{new Date(wait.nextCheckAt).getTime() <= Date.now() ? "Check overdue since" : "Waiting until"} {formatMonitorAbsolute(wait.nextCheckAt)}</time>
      </Badge>
      <span>{wait.reason}</span>
    </span>
  );
}
