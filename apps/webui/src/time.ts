export type RunTimingInput = {
  state: string;
  elapsed_sec: number;
  created_at?: string;
  started_at?: string;
  ended_at?: string;
};

export function isTerminalRunState(state: string): boolean {
  return ["completed", "failed", "cancelled", "pass", "fail"].includes(state);
}

export function displayElapsedSec(run: RunTimingInput, nowMs: number, fallbackStartMs: number | null = null): number {
  const stored = Math.max(0, Math.floor(run.elapsed_sec));
  const startedAt = parseIsoTimeMs(run.started_at) ?? fallbackStartMs ?? parseIsoTimeMs(run.created_at);

  if (startedAt === null) return stored;

  const endedAt = parseIsoTimeMs(run.ended_at);
  if (endedAt !== null) return secondsBetween(startedAt, endedAt);
  if (isTerminalRunState(run.state)) return stored;
  return secondsBetween(startedAt, nowMs);
}

export function parseIsoTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function secondsBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}
