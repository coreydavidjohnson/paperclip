// One-way admission fence: operator task-drain release cannot reopen termination.
let deadline: number | null = null;
export const CONTROLLER_DRAIN_GRACE_MS = 120_000;
export function beginControllerDrain(now = Date.now(), graceMs = CONTROLLER_DRAIN_GRACE_MS) {
  deadline ??= now + graceMs;
  return deadline;
}
export function isControllerDraining() { return deadline !== null; }
export function controllerDrainRemainingMs(now = Date.now()) {
  return deadline === null ? CONTROLLER_DRAIN_GRACE_MS : Math.max(0, deadline - now);
}
