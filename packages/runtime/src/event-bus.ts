type Handler = (e: Record<string, unknown>) => void | Promise<void>;

export class EventBus {
  private subs = new Map<string, Set<Handler>>();

  async emit(event: Record<string, unknown>): Promise<void> {
    for (const [pattern, handlers] of this.subs) {
      if (pattern === "*" || pattern === event.type) {
        for (const h of handlers) {
          try { await h(event); } catch { /* don't break other subscribers */ }
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
