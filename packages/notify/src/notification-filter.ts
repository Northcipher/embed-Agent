interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
  subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void;
}

export interface NotifyConfig {
  enabled: boolean;
  on?: Partial<Record<SemanticCategory, boolean>>;
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
    // Match both target state=offline and transport disconnected states
    condition: (e) => {
      const s = (e.payload as Record<string, unknown>)?.state as string;
      return s === "offline" || s === "disconnected";
    },
  },
  suggestion_generated: {
    category: "memory_suggestion",
    // Observer suggestions and memory suggestions both route here
    condition: () => true,
  },
};

const DEFAULT_TEMPLATES: Record<string, NotifyTemplate> = {
  run_result: {
    title: "Run {{status}}",
    body: "Run {{run_id}}: {{summary}}\nEvidence: {{evidence_path}}\nNext: {{suggested_next}}",
    channel: "slack",
    throttle_sec: 300, // 5 minutes per design
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
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>(); // escalation timers
  private config: NotifyConfig;
  private notifyOn: Partial<Record<string, boolean>>;

  constructor(
    private eb: EventEmitter,
    private channels: Record<string, NotifyChannel>,
    private templates: Record<string, NotifyTemplate> = DEFAULT_TEMPLATES,
    config?: NotifyConfig,
  ) {
    this.config = config ?? { enabled: true };
    this.notifyOn = this.config.on ?? {};
  }

  start(): void {
    this.unsub = this.eb.subscribe(
      ["result_ready", "target_state_changed", "suggestion_generated"],
      e => this.handleEvent(e),
    );
  }

  stop(): void {
    this.unsub?.();
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    // Config gating: globally disabled or category explicitly off
    if (!this.config.enabled) return;

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

    // Check if this category is enabled in config
    if (this.notifyOn[category] === false) return;

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
        // Set a 30-minute timer for automatic escalation — fires even without new events
        const timer = setTimeout(async () => {
          const longTpl = this.templates["target_offline_long"];
          if (longTpl) {
            const longKey = `target_offline_long-${targetId}`;
            await this.sendNotification(longTpl, "target_offline_long", longKey, event);
          }
          this.offlineTimers.delete(targetId);
        }, 30 * 60 * 1000);
        this.offlineTimers.set(targetId, timer);
      }
    } else {
      this.offlineSince.delete(targetId ?? "");
      // Clear escalation timer if target came back
      if (targetId) {
        const timer = this.offlineTimers.get(targetId);
        if (timer) { clearTimeout(timer); this.offlineTimers.delete(targetId); }
      }
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
