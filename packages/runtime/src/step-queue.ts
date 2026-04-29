import type { Step } from "@embed-agent/contracts";

export class StepQueue {
  private steps: Step[] = [];
  private index = 0;
  private _paused = false;

  load(steps: Step[]): void {
    this.steps = [...steps];
    this.index = 0;
    this._paused = false;
  }

  next(): Step | null {
    if (this._paused) return null;
    if (this.index >= this.steps.length) return null;
    return this.steps[this.index++]!;
  }

  append(step: Step): void {
    this.steps.push(step);
  }

  clear(): void {
    this.steps = [];
    this.index = 0;
  }

  pause(): void { this._paused = true; }
  resume(): void { this._paused = false; }

  get remaining(): number { return this.steps.length - this.index; }
  get isEmpty(): boolean { return this.index >= this.steps.length; }
}
