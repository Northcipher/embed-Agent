export interface NotifyChannel {
  send(message: string): Promise<void>;
}

export class NotificationFilter {
  private sentKeys: Set<string> = new Set();
  private offlineSince: Map<string, number> = new Map();

  constructor(private channels: NotifyChannel[]) {}

  async handleEvent(event: Record<string, unknown>): Promise<void> {
    const runId = event.run_id as string | undefined;
    const type = event.type as string;

    if (type === "result_ready") {
      const status = event.status as string;
      const summary = event.summary as string;
      const msg = `Run ${runId} ${status}: ${summary}`;
      await this.send(msg);
      return;
    }

    if (type === "target_state_changed") {
      // Simplified: just track offline
    }
  }

  private async send(msg: string): Promise<void> {
    const key = msg.slice(0, 80);
    if (this.sentKeys.has(key)) return;
    this.sentKeys.add(key);

    for (const ch of this.channels) {
      await ch.send(msg).catch(() => {});
    }
  }
}
