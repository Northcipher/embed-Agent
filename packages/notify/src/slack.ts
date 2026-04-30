import type { NotifyChannel } from "./notification-filter.js";

export class SlackChannel implements NotifyChannel {
  constructor(private webhookUrl: string) {}

  async send(title: string, body: string, metadata: Record<string, unknown>): Promise<void> {
    const payload = {
      text: `*${title}*\n${body}`,
      ...(Object.keys(metadata).length > 0 ? { attachments: [{ text: JSON.stringify(metadata, null, 2) }] } : {}),
    };

    const resp = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
    }
  }
}
