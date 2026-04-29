// Views - read-only projections (stubs for Phase 5)
export class RunView {
  async getStatus(_runId: string): Promise<Record<string, unknown> | null> { return null; }
  async listRuns(): Promise<Record<string, unknown>[]> { return []; }
}

export class TargetView {
  async getTarget(_targetId: string): Promise<Record<string, unknown> | null> { return null; }
  async listTargets(): Promise<Record<string, unknown>[]> { return []; }
}

export class EvidenceView {
  async getIndex(_runId: string): Promise<Record<string, unknown> | null> { return null; }
}
