interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
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

// Semantic categories mapped from raw event types
type SemanticCategory = "run_result" | "target_offline" | "target_offline_long" | "memory_suggestion" | "target_state_change";

const CATEGORY_MAP: Record<string, { category: SemanticCategory; condition?: (e: Record<string, unknown>) => boolean }> = {
  result_ready: { category: "run_result" },
  target_state_changed: {
    category: "target_offline",
    condition: (e) => (e.payload as Record<string, unknown>)?.state === "disconnected",
  },
  suggestion_generated: { category: "memory_suggestion" },
};

const DEFAULT_TEMPLATES: Record<string, NotifyTemplate> = {
  run_result: {
    title: "Run {{status}}",
    body: "Run {{run_id}}: {{summary}}\nEvidence: {{evidence_path}}\nNext: {{suggested_next}}",
    channel: "slack",
    throttle_sec: 60,
  },
  target_offline: {
    title: "Target Offline",
    body: "Target disconnected: {{summary}}",
    channel: "slack",
    throttle_sec: 300,
  },
  target_offline_long: {
    title: "Target Offline (30+ min)",
    body: "Target has been offline for 30+ minutes: {{summary}}",
    channel: "email",
    throttle_sec: 1800,
  },
  target_state_change: {
    title: "Target State Change",
    body: "Target state changed: {{summary}}",
    channel: "log",
    throttle_sec: 300,
  },
  memory_suggestion: {
    title: "Suggestion",
    body: "{{suggestion}}",
    channel: "slack",
    throttle_sec: 300,
  },
};

export class NotificationFilter {
  private unsub: (() => void) | null = null;
  private sentMap = new Map<string, number>(); // key → last sent timestamp
  private offlineSince = new Map<string, number>(); // target → first offline timestamp

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
    const mapping = CATEGORY_MAP[event.type as string];
    if (!mapping) return;

    // Check semantic condition (e.g., only offline state for target_offline)
    let category = mapping.category;
    if (mapping.condition && !mapping.condition(event)) {
      // Fall back to generic category if the specific condition isn't met
      if (event.type === "target_state_changed") {
        category = "target_state_change";
      } else {
        return;
      }
    }

    const tpl = this.templates[category];
    if (!tpl) return;

    // Dedup: per-target for target events, per-run for run events
    const targetId = (event.payload as Record<string, unknown>)?.target_id as string | undefined;
    const dedupKey = targetId ? `${category}-${targetId}` : `${category}-${event.run_id ?? "global"}`;
    const last = this.sentMap.get(dedupKey);
    if (last && (Date.now() - last) < tpl.throttle_sec * 1000) return;

    // Track target offline duration for escalation
    if (category === "target_offline" && targetId) {
      if (!this.offlineSince.has(targetId)) {
        this.offlineSince.set(targetId, Date.now());
      } else if (Date.now() - this.offlineSince.get(targetId)! >= 30 * 60 * 1000) {
        // Escalate to long offline
        const longTpl = this.templates["target_offline_long"];
        if (longTpl) {
          await this.sendNotification(longTpl, "target_offline_long", dedupKey, event);
        }
        return;
      }
    } else {
      this.offlineSince.delete(targetId ?? "");
    }

    await this.sendNotification(tpl, category, dedupKey, event);
  }

  private async sendNotification(
    tpl: NotifyTemplate, category: string, dedupKey: string, event: Record<string, unknown>,
  ): Promise<void> {
    const title = this.render(tpl.title, event);
    const body = this.render(tpl.body, event);
    const channel = this.channels[tpl.channel];
    if (!channel) return;

    try {
      await channel.send(title, body, { event_type: event.type as string, category });
      this.sentMap.set(dedupKey, Date.now());

      // Emit notification_sent audit event
      await this.eb.emit({
        type: "notification_sent", source: "notification_filter",
        summary: `Notification sent: ${category} — ${title}`,
        payload: { category, channel: tpl.channel },
      });
    } catch {
      // notification failure is non-fatal
    }
  }

  private render(template: string, event: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
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
