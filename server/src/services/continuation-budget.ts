import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

const MAX_CONTINUATION_BYTES = 24 * 1024;
const MAX_AGENT_COMMENTS = 5;
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e"), "utf8");
const agentAuthored = (message: ExecutionContinuationEnvelope["messages"][number]) =>
  message.authorType === "agent" || Boolean(message.createdByRunId);

export function boundExecutionContinuation(envelope: ExecutionContinuationEnvelope): ExecutionContinuationEnvelope {
  const agentMessages = envelope.messages.filter(agentAuthored);
  const retainedIds = new Set(agentMessages.slice(-MAX_AGENT_COMMENTS).map(message => message.id));
  let bounded: ExecutionContinuationEnvelope = {
    ...envelope,
    messages: envelope.messages.filter(message => !agentAuthored(message) || retainedIds.has(message.id)),
    completedWork: envelope.completedWork && envelope.completedWork.length > 2048
      ? `${envelope.completedWork.slice(0, 2048)}…` : envelope.completedWork,
  };
  const updateCoverage = () => {
    const omitted = envelope.messages.length - bounded.messages.length;
    if (omitted) bounded.coverage = {
      ...envelope.coverage,
      kind: "bounded_task_history",
      omittedAgentCommentCount: (envelope.coverage.omittedAgentCommentCount ?? 0) + omitted,
      historyPath: `/api/issues/${envelope.issueId}/comments`,
    };
    if (envelope.resumeDelta) {
      const retained = new Set(bounded.messages.map(message => message.id));
      bounded.resumeDelta = { ...envelope.resumeDelta,
        messages: envelope.resumeDelta.messages.filter(message => retained.has(message.id)),
      };
    }
  };
  updateCoverage();
  while (encodedBytes(bounded) > MAX_CONTINUATION_BYTES) {
    const oldest = bounded.messages.findIndex(agentAuthored);
    if (oldest === -1) break;
    bounded.messages = bounded.messages.filter((_message, index) => index !== oldest);
    updateCoverage();
  }
  if (encodedBytes(bounded) <= MAX_CONTINUATION_BYTES) return bounded;
  return {
    version: 1, companyId: envelope.companyId, issueId: envelope.issueId,
    trigger: { ...envelope.trigger, reason: envelope.trigger.reason.slice(0, 128) },
    originCommentIds: [],
    objective: "Read the current issue description, complete human direction, pending interactions and saved work from the task thread before taking action. Missing inline history is not approval or permission to repeat completed work.",
    objectiveSource: envelope.objectiveSource,
    messages: [], humanResponses: [], relayedResponses: [], interactionOutcomes: [],
    completedActions: [], completedWork: null,
    unresolvedInteractionIds: envelope.unresolvedInteractionIds.slice(0, 100),
    coverage: {
      kind: "bounded_task_history", throughCommentId: envelope.coverage.throughCommentId,
      summaryThroughCommentId: null, requiresThreadFetch: true,
      historyPath: `/api/issues/${envelope.issueId}/comments`,
      omittedAgentCommentCount: agentMessages.length,
      pendingInteractionCount: envelope.unresolvedInteractionIds.length,
    },
  };
}
