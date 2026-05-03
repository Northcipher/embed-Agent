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

  /**
   * Load skill steps with random perturbation.
   *
   * Fetches up to `candidatePool` matches, then randomly samples `n` from the pool
   * using reservoir sampling. This prevents the model from memorizing and lazily
   * copying a fixed top-N — each Planner call sees different (but relevant) examples.
   */
  loadMatchedSteps(task: string, n = 3, candidatePool = 20): (Skill & { steps: NonNullable<Skill["steps"]> })[] {
    const candidates = this.match(task).slice(0, candidatePool);
    const sampled = reservoirSample(candidates, Math.min(n, candidates.length));

    return sampled
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

/**
 * Reservoir sampling — randomly select k items from a stream.
 * Ensures each item has equal probability of being selected.
 * Used to perturb few-shot examples so the model doesn't memorize a fixed top-N.
 */
function reservoirSample<T>(items: T[], k: number): T[] {
  if (items.length <= k) return [...items];
  const result = items.slice(0, k);
  for (let i = k; i < items.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) result[j] = items[i]!;
  }
  return result;
}
