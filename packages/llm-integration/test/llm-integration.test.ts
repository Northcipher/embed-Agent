import { describe, expect, it } from "vitest";
import {
  GatewayProvider,
  LlmCallManager,
  MockProvider,
  assemblePrompt,
  createDefaultPromptRegistry,
  createRuleBasedReply,
  parseSingleJsonObject,
  validateAgentReply,
  validateObserverIntent,
  validateTaskPlannerOutput
} from "../src/index.js";

describe("llm-integration foundation", () => {
  it("assembles bounded prompts from versioned registry definitions", () => {
    const registry = createDefaultPromptRegistry();
    const definition = registry.getActiveByRole("observer");

    const prompt = assemblePrompt(definition, [
      { name: "run", content: JSON.stringify({ run_id: "run-001" }) },
      { name: "target_state", content: JSON.stringify({ adb: "offline" }) },
      { name: "output_schema", content: "ObserverIntent.v1" }
    ]);

    expect(prompt.prompt_id).toBe("observer.v1");
    expect(prompt.user).toContain("## run");
    expect(prompt.user).toContain("ObserverIntent.v1");
    expect(prompt.truncated).toBe(false);
  });

  it("extracts exactly one JSON object from model output", () => {
    expect(parseSingleJsonObject("```json\n{\"ok\":true}\n```")).toEqual({
      status: "parsed",
      value: { ok: true }
    });

    expect(parseSingleJsonObject("{\"a\":1} {\"b\":2}")).toMatchObject({
      status: "parse_failed",
      error: "multiple JSON objects found"
    });
  });

  it("validates mock provider output through the call manager", async () => {
    const manager = new LlmCallManager(new MockProvider(["{\"intent\":\"continue\"}"]));

    const result = await manager.completeAndParse({
      callId: "observer-001",
      role: "observer",
      promptId: "observer.v1",
      model: "mock",
      system: "json only",
      user: "return json",
      timeoutSec: 1
    });

    expect(result.status).toBe("parsed");
    expect(result.parse_result).toMatchObject({ status: "parsed" });
  });

  it("keeps timeout enforcement when caller also passes an abort signal", async () => {
    const manager = new LlmCallManager({
      providerId: "slow",
      completeJson: input =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    });

    const result = await manager.completeAndParse({
      callId: "observer-timeout",
      role: "observer",
      promptId: "observer.v1",
      model: "mock",
      system: "json only",
      user: "return json",
      timeoutSec: 0,
      signal: new AbortController().signal
    });

    expect(result.status).toBe("timeout");
  });

  it("posts bounded prompt fields to a gateway provider", async () => {
    const provider = new GatewayProvider({
      baseUrl: "https://gateway.example.test/complete-json",
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
        expect(JSON.parse(String(init?.body)).prompt_id).toBe("task_planner.v1");
        return new Response(JSON.stringify({ output_text: "{\"status\":\"ok\"}", model: "gateway-model" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await provider.completeJson({
      callId: "task-planner-001",
      role: "task_planner",
      promptId: "task_planner.v1",
      model: "gateway-model",
      system: "json only",
      user: "{}",
      timeoutSec: 1
    });

    expect(result.rawText).toBe("{\"status\":\"ok\"}");
  });

  it("rejects planner output with unknown capability", () => {
    const validation = validateTaskPlannerOutput(plannedOutput("unknown_capability"), {
      availableCapabilities: ["watch_serial"],
      hasTestHint: true
    });

    expect(validation).toMatchObject({
      status: "invalid",
      failure_status: "plan_rejected"
    });
  });

  it("rejects planner shell commands invented without test_hint", () => {
    const validation = validateTaskPlannerOutput(plannedOutput("shell_exec", { command: "/vendor/bin/smoke_test" }), {
      availableCapabilities: ["shell_exec"],
      hasTestHint: false
    });

    expect(validation).toMatchObject({
      status: "invalid",
      failure_status: "clarification_needed"
    });
  });

  it("rejects observer requested actions outside the allowed follow-up set", () => {
    const validation = validateObserverIntent(
      {
        intent: "collect_more",
        reason: "need unsupported push",
        confidence: 0.8,
        requested_actions: [{ capability: "push", input: { src_ref: "a", dst_path: "/tmp/a" } }],
        report_to_caller: false
      },
      {
        allowedFollowUpCapabilities: ["collect_logs", "save_snapshot"],
        remainingDurationSec: 30
      }
    );

    expect(validation).toMatchObject({
      status: "invalid",
      failure_status: "observer_intent_rejected"
    });
  });

  it("rejects replies that cite missing evidence refs and can create a rule-based fallback", () => {
    const validation = validateAgentReply(
      {
        run_id: "run-001",
        status: "failed",
        summary: "run failed",
        key_evidence: [{ summary: "panic", evidence_refs: ["serial:missing"] }],
        evidence_path: "/tmp/run-001"
      },
      {
        runId: "run-001",
        finalStatus: "failed",
        evidenceRefs: ["serial:last-200-lines"]
      }
    );

    expect(validation.status).toBe("invalid");
    expect(createRuleBasedReply({ runId: "run-001", status: "failed", evidencePath: "/tmp/run-001" }).key_evidence).toEqual([]);
  });
});

function plannedOutput(capability: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "planned",
    validation_intent: {
      intent_id: "intent-001",
      feature_area: "boot",
      confidence: 0.8,
      matched_scenarios: [{ name: "boot", reason: "boot request" }],
      expected_behavior: ["boot completes"],
      risk_focus: ["panic"],
      suggested_actions: ["observe boot"],
      observe: ["serial"],
      evidence_need: ["serial log"],
      pass_fail: ["no panic"],
      assumptions: [],
      missing_info: []
    },
    plan: {
      plan_id: "plan-001",
      intent_ref: "intent-001",
      estimated_duration_sec: 60,
      steps: [
        {
          id: "step-1",
          capability,
          condition: "always",
          input,
          timeout_sec: 60
        }
      ],
      success_criteria: ["no panic"],
      failure_signals: ["panic"],
      evidence_policy: {
        always: ["events"]
      }
    },
    missing_info: [],
    assumptions: []
  };
}
