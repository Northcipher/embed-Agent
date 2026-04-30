interface EventEmitter {
  subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void;
}

export interface NotifyChannel {
  send(title: string, body: string, metadata: Record<string, unknown>): Promise<void>;
}

export interface NotifyTemplate {
  title: string;
  body: string;
  channel: "slack" | "email" | "log";
  throttle_sec: number;
}

interface NotifyRule {
  eventType: string;
  template: NotifyTemplate;
  condition?: (event: Record<string, unknown>) => boolean;
}

const DEFAULT_TEMPLATES: Record<string, NotifyTemplate> = {
  result_ready: {
    title: "Run {{status}}",
    body: "Run {{run_id}}: {{summary}}",
    channel: "slack",
    throttle_sec: 60,
  },
  target_state_changed: {
    title: "Target State Change",
    body: "Target state changed: {{summary}}",
    channel: "log",
    throttle_sec: 300,
  },
  suggestion_generated: {
    title: "Suggestion",
    body: "{{suggestion}}",
    channel: "slack",
    throttle_sec: 300,
  },
};

export class NotificationFilter {
  private unsub: (() => void) | null = null;
  private sentMap = new Map<string, number>(); // key → last sent timestamp

  constructor(
    private eb: EventEmitter,
    private channels: Record<string, NotifyChannel>,
    private templates: Record<string, NotifyTemplate> = DEFAULT_TEMPLATES,
  ) {}

  start(): void {
    this.unsub = this.eb.subscribe(
      ["result_ready", "target_state_changed", "suggestion_generated"],
      e => { this.handleEvent(e); },
    );
  }

  stop(): void {
    this.unsub?.();
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const tpl = this.templates[event.type as string];
    if (!tpl) return;

    // Dedup by event type + run_id
    const dedupKey = `${event.type}-${event.run_id ?? "global"}`;
    const last = this.sentMap.get(dedupKey);
    if (last && (Date.now() - last) < tpl.throttle_sec * 1000) return;

    const title = this.render(tpl.title, event);
    const body = this.render(tpl.body, event);
    const channel = this.channels[tpl.channel];
    if (!channel) return;

    try {
      await channel.send(title, body, { event_type: event.type as string });
      this.sentMap.set(dedupKey, Date.now());
    } catch {
      // notification failure is non-fatal
    }
  }

  private render(template: string, event: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      // Drill into payload for nested values
      if (key in event) return String(event[key] ?? "");
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && key in payload) return String(payload[key] ?? "");
      return `{{${key}}}`;
    });
  }
}

// --- Log channel (for testing) ---

export class LogChannel implements NotifyChannel {
  public messages: { title: string; body: string; metadata: Record<string, unknown> }[] = [];

  async send(title: string, body: string, metadata: Record<string, unknown>): Promise<void> {
    this.messages.push({ title, body, metadata });
  }
}
