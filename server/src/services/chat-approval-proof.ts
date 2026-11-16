import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type HumanSession = { type: string; source?: string; userId?: string; sessionId?: string | null; chatApprovalSession?: boolean; chatApprovalAccountId?: string; memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>; agentId?: string; runId?: string };
export type Enrollment = {
  companyId: string; issueId: string; interactionId: string; userId: string;
  chatId: string; submittingAgentId: string; revision: string;
  loginAccountId: string; designationId: string; designationHash: string; expiresAt: string;
  action: string; target: string; scope: string; undo: string;
  effect: "synthetic_test_only";
};
export function designationQuestion(e: Omit<Enrollment, "loginAccountId" | "designationId" | "designationHash" | "expiresAt">) {
  return { id: "designate-test-account", prompt: "Which login account do you choose for this one test?",
    helpText: `Type the account ID from your private sign-in page. This choice binds that account to the test below for no more than 24 hours after your answer. It does not answer the test. Do not choose this option if the account is not yours.\nAction: ${e.action}\nTarget: ${e.target}\nScope: ${e.scope}\nUndo: ${e.undo}\nCompany: ${e.companyId}\nIssue: ${e.issueId}\nTest card: ${e.interactionId}\nHuman: ${e.userId}\nChat: ${e.chatId}\nAgent: ${e.submittingAgentId}\nPolicy: ${e.revision}\nEffect: ${e.effect}`,
    selectionMode: "single" as const, required: true, allowOther: false,
    options: [{ id: "bind-this-account", label: "Bind my account to this test", freeText: true }] };
}
export type ChatApprovalConfig = { origin: string; key: string; enrollments: Enrollment[] };
export type Presentation = {
  version: 1; responseId: string; userId: string; sessionTag: string;
  enrollmentHash: string; snapshotHash: string; issuedAt: number; expiresAt: number;
};

export class ApprovalProofError extends Error {}
export function isChatApprovalPath(req: { path: string; method: string }) {
  return ["GET", "POST"].includes(req.method)
    && /^\/api\/issues\/[a-f0-9-]{36}\/interactions\/[a-f0-9-]{36}\/chat-approval\/?$/i.test(req.path);
}
function refuse(message: string): never { throw new ApprovalProofError(message); }
export function digest(value: unknown): string {
  // Snapshots are built server-side with a fixed field order, never from client JSON.
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function requireHuman(actor: HumanSession): asserts actor is HumanSession & { userId: string; sessionId: string } {
  if (actor.type !== "board" || actor.source !== "session" || actor.chatApprovalSession !== true || !actor.userId || !actor.sessionId
    || actor.agentId || actor.runId) refuse("A separate human login session is required");
}
export function readChatApprovalConfig(env: NodeJS.ProcessEnv = process.env): ChatApprovalConfig | null {
  if (env.PAPERCLIP_CHAT_APPROVAL_ENABLED !== "1") return null;
  const origin = env.PAPERCLIP_CHAT_APPROVAL_ORIGIN ?? "";
  const key = env.PAPERCLIP_CHAT_APPROVAL_HMAC_KEY ?? "";
  const raw = env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS ?? "";
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || key.length < 32 || raw.length > 16384) refuse("Invalid chat approval configuration");
  const enrollments: unknown = JSON.parse(raw);
  if (!Array.isArray(enrollments) || enrollments.length > 20) refuse("Invalid enrollments");
  const fields = ["companyId", "issueId", "interactionId", "userId", "chatId", "submittingAgentId", "revision", "action", "target", "scope", "undo", "effect", "loginAccountId", "designationId", "designationHash", "expiresAt"].sort();
  for (const e of enrollments) {
    if (!e || typeof e !== "object" || Object.keys(e).sort().join() !== fields.join()
      || fields.some(f => typeof e[f] !== "string" || !e[f] || e[f].length > 2000)
      || e.effect !== "synthetic_test_only" || !/^[a-f0-9]{64}$/.test(e.designationHash)
      || !Number.isFinite(Date.parse(e.expiresAt))) refuse("Only explicitly enrolled synthetic tests are supported");
  }
  if (new Set(enrollments.map(e => e.interactionId)).size !== enrollments.length) refuse("Duplicate enrollment");
  return { origin, key, enrollments: enrollments as Enrollment[] };
}
export function requireEnrollment(config: ChatApprovalConfig, issueId: string, interactionId: string, actor: HumanSession) {
  requireHuman(actor);
  const enrollment = config.enrollments.find(e => e.issueId === issueId && e.interactionId === interactionId && e.userId === actor.userId && e.loginAccountId === actor.chatApprovalAccountId);
  if (!enrollment) refuse("This card is not enrolled for this human");
  return enrollment;
}
export function assertSimpleTestCard(enrollment: Enrollment, card: {
  id: string; companyId: string; issueId: string; kind: string; createdByAgentId: string | null; payload: unknown;
}) {
  const payload = card.payload as Record<string, unknown>;
  // A source-controlled enrollment cannot turn a native governed action into a test.
  if (card.id !== enrollment.interactionId || card.companyId !== enrollment.companyId || card.issueId !== enrollment.issueId
    || card.createdByAgentId !== enrollment.submittingAgentId || card.kind !== "request_confirmation"
    || !payload || typeof payload.prompt !== "string"
    || (payload.acceptLabel != null && payload.acceptLabel !== "Approve")
    || (payload.rejectLabel != null && payload.rejectLabel !== "Deny")
    || Object.keys(payload).some(k => !["version", "prompt", "detailsMarkdown", "acceptLabel", "rejectLabel", "allowDeclineReason", "supersedeOnUserComment"].includes(k))) {
    refuse("Only a plain, enrolled test confirmation can use this path");
  }
}
function sessionTag(key: string, actor: HumanSession) { return createHmac("sha256", key).update(actor.sessionId!).digest("hex"); }
function sign(key: string, body: string) { return createHmac("sha256", key).update(body).digest("base64url"); }
export function present(config: ChatApprovalConfig, enrollment: Enrollment, actor: HumanSession, snapshot: unknown, now = Date.now()) {
  requireHuman(actor);
  const presentation: Presentation = { version: 1, responseId: randomUUID(), userId: actor.userId,
    sessionTag: sessionTag(config.key, actor), enrollmentHash: digest(enrollment), snapshotHash: digest(snapshot), issuedAt: now, expiresAt: now + 600_000 };
  const body = Buffer.from(JSON.stringify(presentation)).toString("base64url");
  return { presentation, token: `${body}.${sign(config.key, body)}` };
}
export function verify(config: ChatApprovalConfig, enrollment: Enrollment, actor: HumanSession, token: unknown, origin: unknown, now = Date.now()): Presentation {
  requireHuman(actor);
  if (origin !== config.origin || typeof token !== "string" || token.length > 4096) refuse("Invalid approval origin or proof");
  const [body, signature, extra] = token.split(".");
  const expected = sign(config.key, body ?? "");
  if (!body || !signature || extra !== undefined || Buffer.byteLength(signature) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) refuse("Invalid approval proof");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Presentation;
  if (p.version !== 1 || typeof p.responseId !== "string" || p.userId !== actor.userId || p.sessionTag !== sessionTag(config.key, actor)
    || p.enrollmentHash !== digest(enrollment) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)
    || p.issuedAt > now || p.expiresAt <= now || p.expiresAt - p.issuedAt !== 600_000) refuse("Expired or mismatched approval proof");
  return p;
}
export function parseAnswer(choice: unknown, answer: unknown) {
  if (typeof choice !== "string" || typeof answer !== "string" || answer.length > 256) refuse("Invalid answer");
  const typed = answer.trim().toLowerCase();
  const typedChoice = typed === "approve" ? "accept" : typed === "deny" ? "reject" : null;
  if (answer.trim() && !typedChoice) refuse("Type only Approve or Deny");
  if (choice && !["accept", "reject", "revoke"].includes(choice)) refuse("Invalid choice");
  if (choice && typedChoice && choice !== typedChoice) refuse("The typed answer conflicts with the selected choice");
  const decision = choice || typedChoice;
  if (!decision) refuse("An explicit answer is required");
  return { decision: decision as "accept" | "reject" | "revoke", exactAnswer: answer.trim() ? answer : decision === "accept" ? "Approve" : decision === "reject" ? "Deny" : "Stop chat approval" };
}
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export function renderPrompt(enrollment: Enrollment, prompt: string, helpText: string, token: string, path: string) {
  const e = escapeHtml;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test approval</title><body style="font:1rem sans-serif"><main style="max-width:36rem;margin:2rem auto;padding:1rem;overflow-wrap:anywhere">
<style>button,input{font:inherit;min-height:44px;box-sizing:border-box;max-width:100%}button{padding:.5rem .75rem}form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}label{flex-basis:100%}</style>
<h1>Test approval</h1><p>This answer applies only to the test shown below. It does not permit production work.</p>
<h2>${e(prompt)}</h2><pre style="white-space:pre-wrap">${e(helpText)}</pre>
<dl><dt>Action</dt><dd>${e(enrollment.action)}</dd><dt>Target</dt><dd>${e(enrollment.target)}</dd><dt>Scope</dt><dd>${e(enrollment.scope)}</dd><dt>Undo limit</dt><dd>${e(enrollment.undo)}</dd></dl>
<p>Select Approve to permit this test. Select Deny to refuse it. Select Stop chat approval to keep the card open and disable this chat path for this card.</p>
<p>This prompt expires in 10 minutes. You can also type Approve or Deny. A typed answer must match any button you select.</p>
<form method="post" action="${e(path)}"><input type="hidden" name="proof" value="${e(token)}">
<label for="answer">Your answer</label><input id="answer" name="answer" maxlength="256" autocomplete="off">
<button name="choice" value="">Send typed answer</button><button name="choice" value="accept">Approve</button><button name="choice" value="reject">Deny</button><button name="choice" value="revoke">Stop chat approval</button></form>
<p><a style="display:inline-flex;align-items:center;min-height:44px;max-width:100%;box-sizing:border-box;padding:.5rem .75rem" href="/api/chat-approval-auth/login">Manage test sign-in or sign out</a></p>
</main></body></html>`;
}
export function renderApprovalStatus(title: string, message: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><main style="max-width:36rem;margin:2rem auto;padding:1rem;font:1rem sans-serif;overflow-wrap:anywhere"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a style="display:inline-flex;align-items:center;min-height:44px;max-width:100%;box-sizing:border-box;padding:.5rem .75rem" href="/api/chat-approval-auth/login">Manage test sign-in or sign out</a></p><p>This record is not proof that the test ran.</p></main></html>`;
}
