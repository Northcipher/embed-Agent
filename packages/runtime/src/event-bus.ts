type Handler = (e: Record<string, unknown>) => void | Promise<void>;

export class EventBus {
  private subs = new Map<string, Set<Handler>>();
  /** Per-run queues: serialize event delivery within each run_id for ordering guarantees. */
  private runQueues = new Map<string, Promise<void>>();

  async emit(event: Record<string, unknown>): Promise<void> {
    const runId = event.run_id as string | undefined;

    if (runId) {
      // Serialize within this run_id — chain behind the previous emit for the same run
      const prev = this.runQueues.get(runId) ?? Promise.resolve();
      const next = prev.then(() => this.deliver(event));
      this.runQueues.set(runId, next);
      // Clean up the queue reference when done to avoid memory leak
      next.finally(() => { if (this.runQueues.get(runId) === next) this.runQueues.delete(runId); });
      await next;
    } else {
      // Global events — no per-run ordering needed
      await this.deliver(event);
    }
  }

  private async deliver(event: Record<string, unknown>): Promise<void> {
    for (const [pattern, handlers] of this.subs) {
      if (pattern === "*" || pattern === event.type) {
        for (const h of handlers) {
          try { await h(event); } catch (e) { console.error(`[EventBus] Subscriber error for ${event.type}:`, (e as Error).message); }
        }
      }
    }
  }

  subscribe(types: string[], handler: Handler): () => void {
    for (const t of types) {
      if (!this.subs.has(t)) this.subs.set(t, new Set());
      this.subs.get(t)!.add(handler);
    }
    return () => { for (const t of types) this.subs.get(t)?.delete(handler); };
  }
}
