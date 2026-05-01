import type { Skill } from "@embed-agent/stores";
import type { Plan } from "@embed-agent/contracts";

interface SkillStoreLike {
  loadAll(): Promise<void>;
  match(task: string): Skill[];
  get(name: string): Skill | undefined;
  create(name: string, skill: Skill): Promise<void>;
  list(): Skill[];
}

export class SkillRegistry {
  private loaded = false;

  constructor(private store: SkillStoreLike) {}

  async loadAll(): Promise<void> {
    await this.store.loadAll();
    this.loaded = true;
  }

  /** Match skills by task description. Returns ranked results (best first). */
  match(task: string): Skill[] {
    if (!this.loaded) return [];
    return this.store.match(task);
  }

  /** Get full Skill definition by name. */
  get(name: string): Skill | undefined {
    return this.store.get(name);
  }

  /** Match top-N skills for Planner DynamicContext. */
  matchTop(task: string, n = 3): { name: string; description: string }[] {
    return this.match(task).slice(0, n).map(s => ({
      name: s.name,
      description: s.description,
    }));
  }

  /** Load full skill steps for the matched skills to include in Planner context.
   *  Substitutes {{param_name}} placeholders in step commands with default values. */
  loadMatchedSteps(task: string, n = 3): (Skill & { steps: NonNullable<Skill["steps"]> })[] {
    return this.match(task).slice(0, n)
      .map(s => this.get(s.name))
      .filter((s): s is Skill => s != null)
      .filter(s => s.steps && s.steps.length > 0)
      .map(s => {
        // Build param lookup table from skill defaults
        const defaults = new Map<string, string>();
        if (s.params) {
          for (const p of s.params) {
            if (p.default != null) defaults.set(p.name, String(p.default));
          }
        }
        // Substitute {{param}} in step commands
        const steps = s.steps!.map(step => {
          if (!step.command || !step.command.includes("{{")) return step;
          let cmd = step.command;
          for (const [name, value] of defaults) {
            cmd = cmd.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), value);
          }
          return { ...step, command: cmd };
        });
        return { ...s, steps } as Skill & { steps: NonNullable<Skill["steps"]> };
      });
  }

  /** Create a new skill from a successful Plan. */
  async createFromPlan(name: string, plan: Plan, description: string): Promise<void> {
    const skill: Skill = {
      name,
      description,
      category: "custom",
      params: [],
      steps: plan.steps.map(s => {
        const step: { action: string; capability: string; command?: string; timeout_sec: number } = {
          action: s.action, capability: s.capability, timeout_sec: s.timeout_sec,
        };
        if (s.command) step.command = s.command;
        return step;
      }),
      evidence: plan.evidence_policy,
      success: plan.success_criteria,
      failure: plan.failure_signals,
    };
    await this.store.create(name, skill);
  }
}
