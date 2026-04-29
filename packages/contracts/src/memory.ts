// Working Memory
export interface WorkingMemoryEntry {
  key: string;
  summary: string;
  source: "observer" | "planner" | "human";
  at: string;
}

// Episode
export interface Episode {
  episode_id: string;
  run_id: string;
  target_id: string;
  artifact_ref: string;
  task: string;
  result: string;
  summary: string;
  key_evidence: { summary: string; refs: string[] }[];
  suggestions: string[];
  pitfalls: string[];
  recorded_at: string;
}

// Semantic Fact
export type FactCategory = "known_issue" | "threshold" | "test_entry" | "connection" | "workflow";
export type FactScope = "global" | "target" | "workspace";

export interface SemanticFact {
  fact_id: string;
  scope: FactScope;
  scope_id: string;
  category: FactCategory;
  statement: string;
  source: "auto" | "human_confirmed";
  evidence_refs: string[];
  extended_pattern?: string;
  verified: boolean;
  created_at: string;
}

// RunProfile (baseline)
export interface RunProfile {
  run_id: string;
  target_id: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  result: "completed" | "failed" | "cancelled";
  stage_durations: { stage: string; duration: number }[];
  final_metrics: Record<string, number>;
  output_summary: {
    total_lines: number;
    peak_lines_per_sec: number;
    silence_count: number;
    rule_hits: Record<string, number>;
  };
  recorded_at: string;
}
