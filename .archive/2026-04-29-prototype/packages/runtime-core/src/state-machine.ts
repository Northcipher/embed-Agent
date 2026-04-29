import type { RunState } from "@artifact-validation/contracts";

export const TERMINAL_RUN_STATES = new Set<RunState>(["completed", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: ReadonlyMap<RunState, ReadonlySet<RunState>> = new Map([
  ["queued", new Set(["planning", "cancelled"])],
  ["planning", new Set(["running", "failed", "cancelled"])],
  ["running", new Set(["paused", "collecting_evidence", "cancelled"])],
  ["paused", new Set(["running", "collecting_evidence", "cancelled"])],
  ["collecting_evidence", new Set(["completed", "failed", "cancelled"])],
  ["completed", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()]
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function canTransitionRunState(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function allowedNextRunStates(from: RunState): RunState[] {
  return [...(ALLOWED_TRANSITIONS.get(from) ?? [])];
}

export function validateInitialRunState(state: RunState): boolean {
  return state === "queued" || state === "planning";
}
