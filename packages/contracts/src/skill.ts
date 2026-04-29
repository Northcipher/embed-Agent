export interface Skill {
  name: string;
  description: string;
  category: string;
  params: { name: string; type: string; required: boolean; default?: unknown }[];
  steps: {
    action: string;
    capability: string;
    condition?: string;
    timeout?: number;
    command?: string;
    observe?: { interval: number; metrics: string[] };
    use?: string;
  }[];
  evidence: { always: string[]; on_failure: string[] };
  success: string[];
  failure: string[];
}

export interface SkillSummary {
  name: string;
  category: string;
  description: string;
}
