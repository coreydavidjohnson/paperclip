export function operatorInterruptCancelOptions(input: { issueId: string; actor: { actorType: string; actorId: string } }) {
  return {
    errorCode: "operator_interrupted",
    resultJson: {
      operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt",
      interruptedIssueId: input.issueId,
      interruptedByActorType: input.actor.actorType,
      interruptedByActorId: input.actor.actorId,
    },
    eventMessage: "run interrupted by board comment",
    eventPayload: {
      issueId: input.issueId,
      source: "issue_comment_interrupt",
      interruptedByActorType: input.actor.actorType,
      interruptedByActorId: input.actor.actorId,
    },
  };
}
