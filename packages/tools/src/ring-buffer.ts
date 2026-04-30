export class RingBuffer {
  private buf: string[];
  private head = 0;

  constructor(private maxLines = 500) { this.buf = new Array(maxLines); }

  push(line: string): void { this.buf[this.head % this.maxLines] = line; this.head++; }
  totalPushed(): number { return this.head; }

  getWindow(hitIndex: number, before: number, after: number): string[] {
    const r: string[] = [];
    const start = Math.max(0, hitIndex - before);
    const end = Math.min(this.head, hitIndex + after + 1);
    for (let i = start; i < end; i++) r.push(this.buf[i % this.maxLines]!);
    return r;
  }

  getRecent(limit: number): string[] {
    return this.getWindow(this.head - 1, limit, 0);
  }
}
