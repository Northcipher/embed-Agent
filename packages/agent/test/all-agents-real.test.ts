/**
 * Real API test: Planner → Observer → Reply with DeepSeek.
 * Run: ANTHROPIC_AUTH_TOKEN=xxx npx vitest run packages/agent/test/all-agents-real.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { AIAnthropicProvider, LLMCallManager, Agent, type AgentConfig } from "@embed-agent/agent";
import type { Decision, AgentReply } from "@embed-agent/agent";

// PlanResult is exported from planner.ts via Agent's index
type PlanResult = { status: "planned"; plan: { plan_id: string; steps: { id: string; capability: string; action: string; command?: string; timeout_sec: number }[]; success_criteria: string[]; failure_signals: string[]; evidence_policy: { always: string[]; on_failure: string[] }; estimated_duration_sec: number } } | { status: "clarification_needed"; missing_info: string[]; suggested_next: string };

const TOKEN = process.env["ANTHROPIC_AUTH_TOKEN"];
const BASE = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.deepseek.com/anthropic";
const MODEL = process.env["ANTHROPIC_MODEL"] ?? "deepseek-v4-pro[1m]";

const describeIf = (TOKEN && TOKEN.length > 0) ? describe : describe.skip;

function log(label: string, obj: unknown) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  console.log(`${label}: ${s.slice(0, 400)}`);
}

describeIf("All agents real API", () => {
  const provider = new AIAnthropicProvider(TOKEN!, BASE);
  const llm = new LLMCallManager(provider, {
    planner: { model: MODEL, timeout: 120, maxTokens: 4096 },
    observer: { model: MODEL, timeout: 60, maxTokens: 1024 },
    reply: { model: MODEL, timeout: 60, maxTokens: 2048 },
  });

  // Load prompt files
  let plannerPrompt = "", observerPrompt = "", replyPrompt = "";
  beforeAll(async () => {
    const fs = await import("node:fs/promises");
    const strip = (c: string) => c.replace(/^---[\s\S]*?---\n/, "").trim();
    try { plannerPrompt = strip(await fs.readFile("config/prompts/planner-v1.md", "utf-8")); } catch {}
    try { observerPrompt = strip(await fs.readFile("config/prompts/observer-v1.md", "utf-8")); } catch {}
    try { replyPrompt = strip(await fs.readFile("config/prompts/reply-v1.md", "utf-8")); } catch {}
  });

  // ============================================================
  // Planner
  // ============================================================
  it("Planner: generates valid plan from real LLM", async () => {
    const config: AgentConfig<PlanResult> = {
      parse(content: string): PlanResult {
        try {
          const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          const json = JSON.parse(m ? m[1]!.trim() : content.trim());
          if (json.status === "clarification_needed") return json as PlanResult;
          if (!json.steps?.length) return { status: "clarification_needed", missing_info: ["no steps"], suggested_next: "add steps" };
          for (const s of json.steps) {
            if (!s.id || !s.action || !s.capability || !s.timeout_sec)
              return { status: "clarification_needed", missing_info: [`step missing fields: ${JSON.stringify(s)}`], suggested_next: "fix step format" };
          }
          return { status: "planned", plan: json as PlanResult & { status: "planned" }["plan"] };
        } catch (e) {
          return { status: "clarification_needed", missing_info: [(e as Error).message], suggested_next: "retry" };
        }
      },
      fallback: () => ({ status: "clarification_needed", missing_info: ["LLM failed"], suggested_next: "retry" }),
    };
    const agent = new Agent("planner", llm, config);

    const ctx = [
      "## Goal", "**Task**: Validate firmware v2.4.0 on esp32", "**Expected**: Device boots and responds to shell commands",
      "", "## Target", "**ID**: esp32", "**Artifact**: /tmp/fw-v2.4.0.bin (firmware)", "**Connections**: serial:connected, adb:online",
      "", "## Safety Constraints", "- allow_flash: true", "- allow_shell_exec: true", "- max_duration_sec: 600",
    ].join("\n");

    console.log("\n=== PLANNER ===");
    const result = await agent.run(plannerPrompt, ctx, "test-planner");
    log("Status", result.status);
    if (result.status === "planned") {
      log("Plan", `${result.plan.plan_id} — ${result.plan.steps.length} steps`);
      for (const s of result.plan.steps) log(`  ${s.action}/${s.capability}`, `${s.command ?? "(no cmd)"} [${s.timeout_sec}s]`);
      log("Criteria", result.plan.success_criteria);
      expect(result.plan.steps.length).toBeGreaterThanOrEqual(1);
      for (const s of result.plan.steps) {
        expect(s.id).toBeTruthy();
        expect(s.capability).toBeTruthy();
        expect(s.action).toBeTruthy();
        expect(s.timeout_sec).toBeGreaterThan(0);
      }
    } else {
      log("Missing", result.missing_info);
    }
  }, 120000);

  // ============================================================
  // Observer
  // ============================================================
  it("Observer: generates valid decision from real LLM", async () => {
    const config: AgentConfig<Decision> = {
      parse(content: string): Decision {
        const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        return JSON.parse(m ? m[1]!.trim() : content.trim()) as Decision;
      },
      fallback(reason: string): Decision {
        return { decision: "continue", reason, confidence: 0.3, reasoning_trace: "fallback", evidence_refs: [] };
      },
    };
    const agent = new Agent("observer", llm, config);

    const ctx = [
      "## Run State", "State: running  Elapsed: 45s", "Step: boot_stream",
      "", "## Constraints",
      "Remaining: **500s**", "Capabilities: shell_exec", "CB1: **inactive**", "CB3: **inactive**",
      "", "## Target State", "Serial: connected  ADB: online  Device: busy",
      "", "## Triggering Event", "Type: rule_matched  Severity: **warning**",
      "Summary: Unusual silence on serial — no output for 15 seconds",
      "", "## Recent Signals", "1 signal(s):",
      "- [warning] rule_matched: Unusual silence detected on serial",
      "", "## Evidence Windows", "serial:last-window:", "```[ 12.0] init: starting service```",
      "", "## Known Issues", "- Device sometimes slow to boot after flash (verified)",
    ].join("\n");

    console.log("\n=== OBSERVER ===");
    const result = await agent.run(observerPrompt, ctx, "test-observer");
    log("Decision", result);
    expect(["continue", "stop", "collect_more", "extend_wait", "pause", "suggest"]).toContain(result.decision);
  }, 120000);

  // ============================================================
  // Reply
  // ============================================================
  it("Reply: generates valid verdict from real LLM", async () => {
    const config: AgentConfig<AgentReply> = {
      parse(content: string): AgentReply {
        const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const json = JSON.parse(m ? m[1]!.trim() : content.trim());
        return {
          run_id: "test-reply", status: "completed",
          summary: json.summary ?? "no summary",
          suggested_next: json.suggested_next ?? "review evidence",
          evidence_path: ".embed-agent/runs/test-reply",
          key_evidence: json.key_evidence ?? [],
          confidence: typeof json.confidence === "number" ? json.confidence : 0.7,
          criteria_results: json.criteria_results,
        };
      },
      fallback(reason: string): AgentReply {
        return { run_id: "test-reply", status: "failed", summary: reason, suggested_next: "retry", evidence_path: "", key_evidence: [], confidence: 0.5 };
      },
    };
    const agent = new Agent("reply", llm, config);

    const ctx = [
      "## Success Criteria", "- device boots to shell prompt", "- shell commands execute successfully",
      "", "## Failure Signals", "- kernel panic", "- boot loop", "- serial timeout",
      "", "## Goal", "Task: validate firmware on esp32", "Expected: Device boots and responds to shell",
      "", "## Run Events", "Total: 12  Fatal: 0  Failures: none",
      "- [info] run_started: Run started", "- [info] step_completed: Step boot_stream completed",
      "- [info] step_completed: Step verify_shell completed", "- [info] result_ready: Validation completed successfully",
      "", "## Available Evidence", "- serial:full (serial, 45000 bytes)", "- dmesg:full (log, 8000 bytes)",
    ].join("\n");

    console.log("\n=== REPLY ===");
    const result = await agent.run(replyPrompt, ctx, "test-reply");
    log("Summary", result.summary);
    log("Suggested", result.suggested_next);
    if (result.criteria_results) log("Criteria", result.criteria_results.map(c => `${c.criterion}=${c.status}`));
    log("Confidence", result.confidence);
    expect(result.summary).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
  }, 120000);
});
