import type { Step } from "@embed-agent/contracts";

export type { Step };

export class StepQueue {
  private steps: Step[] = [];
  private cursor = 0;
  private _paused = false;

  load(planSteps: Step[]): void {
    this.steps = [...planSteps];
    this.cursor = 0;
    this._paused = false;
  }

  next(): Step | null {
    if (this._paused) return null;
    if (this.cursor >= this.steps.length) return null;
    const s = this.steps[this.cursor]!;
    this.cursor++;
    return s;
  }

  append(step: Step): void {
    this.steps.push(step);
  }

  clear(): void {
    this.steps = [];
    this.cursor = 0;
  }

  pause(): void { this._paused = true; }
  resume(): void { this._paused = false; }

  get remaining(): number {
    return Math.max(0, this.steps.length - this.cursor);
  }

  get paused(): boolean { return this._paused; }

  peek(): Step | null {
    if (this._paused || this.cursor >= this.steps.length) return null;
    return this.steps[this.cursor]!;
  }
}
