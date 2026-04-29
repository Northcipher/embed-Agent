export class ContextAssembler {
  async assemblePlannerContext(runId: string): Promise<{ staticPrompt: string; dynamicContext: Record<string, unknown> }> {
    return {
      staticPrompt: "You are the Embed Agent Task Planner.",
      dynamicContext: { run_id: runId },
    };
  }

  async assembleObserverContext(runId: string, _event: Record<string, unknown>): Promise<{ staticPrompt: string; input: Record<string, unknown> }> {
    return {
      staticPrompt: "You are the Embed Agent Observer.",
      input: { run_id: runId },
    };
  }
}
