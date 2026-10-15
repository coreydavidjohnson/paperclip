/** Unknown blocker prose is not authority to resume unrelated work. */
export function isDesktopAccessOnlyAction(action: unknown) {
  return typeof action === 'string' && /^(?:restore|recover|re-establish|reestablish) (?:the |this agent.s |home lab.s )?(?:desktop|desktop command|sandbox command|command|desktop\/command) (?:access|availability)(?:\.|!)?$/i.test(action.trim());
}
type BlockedIssue = {
  status: string; assigneeAgentId: string | null; assigneeUserId: string | null;
  statusVersion: number; blockedTransitionAt: Date | null; hiddenAt: Date | null;
  conversationAgentId: string | null; checkoutRunId: string | null; executionRunId: string | null;
  unblockDescriptor: { owner: unknown; action: string } | null;
};
type Audit = { id: string; createdAt: Date; details: Record<string, any> | null };

/** Caller supplies newest-first complete status-affecting audit, under its transaction fence. */
export function desktopBlockedTransition(issue: BlockedIssue, history: Audit[], agentId: string, now: Date) {
  if (issue.status !== 'blocked' || issue.assigneeAgentId !== agentId || issue.assigneeUserId || issue.hiddenAt ||
    issue.conversationAgentId || issue.checkoutRunId || issue.executionRunId || !issue.blockedTransitionAt ||
    !Number.isSafeInteger(issue.statusVersion) || !issue.unblockDescriptor ||
    typeof issue.unblockDescriptor.owner !== 'object' || !issue.unblockDescriptor.owner ||
    (issue.unblockDescriptor.owner as { agentId?: string }).agentId !== agentId ||
    !isDesktopAccessOnlyAction(issue.unblockDescriptor.action)) return null;
  const at = issue.blockedTransitionAt.getTime();
  if (!Number.isFinite(at) || at > now.getTime() || at < now.getTime() - 2 * 60 * 60 * 1000) return null;
  for (const entry of history) {
    const details = entry.details;
    if (!details) return null;
    const changed = details.changes;
    if (changed && changed.status === undefined && ['unblockDescriptor','blockedByIssueIds','assigneeAgentId','assigneeUserId','parentId','reviewPolicy','executionPolicy'].some(key => Object.hasOwn(changed, key))) return null;
    const status = details.changes?.status;
    const from = status?.from ?? details.fromStatus ?? details._previous?.status;
    const to = status?.to ?? details.toStatus ?? details.status;
    if (status === undefined && to === undefined) {
      if (details.changes && Object.keys(details.changes).length > 0) continue;
      return null;
    }
    // A later reassertion or an audit with unknown old status supersedes prior authority.
    if (typeof from !== 'string' || typeof to !== 'string' || from === to || from === 'blocked' || to !== 'blocked') return null;
    // Public writes record the projection stamp. Older/native audits without that
    // stamp require exact time equality; proximity is not transition identity.
    const recordedAt = details.changes?.blockedTransitionAt?.to;
    if (recordedAt !== undefined ? new Date(recordedAt).getTime() !== at : entry.createdAt.getTime() !== at) return null;
    return { transitionId: entry.id, blockedTransitionAt: issue.blockedTransitionAt.toISOString(), statusVersion: issue.statusVersion };
  }
  return null;
}
