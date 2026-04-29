export class RingBuffer {
  private buffer: string[];
  private head = 0;
  private readonly maxLines: number;

  constructor(maxLines = 500) {
    this.maxLines = maxLines;
    this.buffer = new Array(maxLines);
  }

  push(line: string): void {
    this.buffer[this.head % this.maxLines] = line;
    this.head++;
  }

  totalPushed(): number {
    return this.head;
  }

  getWindow(hitIndex: number, before: number, after: number): string[] {
    const result: string[] = [];
    const start = Math.max(0, hitIndex - before);
    const end = Math.min(this.head, hitIndex + after + 1);
    for (let i = start; i < end; i++) {
      result.push(this.buffer[i % this.maxLines]!);
    }
    return result;
  }

  getRecent(limit: number): string[] {
    const start = Math.max(0, this.head - limit);
    return this.getWindow(this.head - 1, limit, 0);
  }
}
