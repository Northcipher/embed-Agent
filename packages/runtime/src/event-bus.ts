type EventHandler = (event: Record<string, unknown>) => void;

export class EventBus {
  private subscribers: Map<string, Set<EventHandler>> = new Map();
  private runQueues: Map<string, { events: Record<string, unknown>[]; processing: boolean }> = new Map();

  emit(event: Record<string, unknown>): void {
    const runId = event.run_id as string | undefined;

    // Per-run ordering
    if (runId) {
      let queue = this.runQueues.get(runId);
      if (!queue) {
        queue = { events: [], processing: false };
        this.runQueues.set(runId, queue);
      }
      queue.events.push(event);
      if (!queue.processing) {
        this.processRunQueue(runId, queue);
      }
    } else {
      // Global events: broadcast immediately
      this.broadcast(event);
    }
  }

  private async processRunQueue(runId: string, queue: { events: Record<string, unknown>[]; processing: boolean }): Promise<void> {
    queue.processing = true;
    while (queue.events.length > 0) {
      const event = queue.events.shift()!;
      this.broadcast(event);
    }
    queue.processing = false;
  }

  private broadcast(event: Record<string, unknown>): void {
    for (const [pattern, handlers] of this.subscribers) {
      if (pattern === "*" || pattern === event.type) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch {
            // handler errors don't break other subscribers
          }
        }
      }
    }
  }

  subscribe(types: string[], handler: EventHandler): () => void {
    for (const type of types) {
      if (!this.subscribers.has(type)) {
        this.subscribers.set(type, new Set());
      }
      this.subscribers.get(type)!.add(handler);
    }
    return () => {
      for (const type of types) {
        this.subscribers.get(type)?.delete(handler);
      }
    };
  }
}
