import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMCallManager, MockProvider, ReplyGenerator } from "../src/index.js";

const tmpDirs: string[] = [];

function makeReplyGenerator(options: { replyLanguage: "zh" | "en"; llmText?: string }) {
  const tmpDir = path.join(os.tmpdir(), `reply-lang-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(tmpDir);

  const mock = new MockProvider();
  mock.setResponse(options.llmText ?? JSON.stringify({
    summary: options.replyLanguage === "zh" ? "验证完成，关键日志正常。" : "Validation completed with normal key logs.",
    suggested_next: options.replyLanguage === "zh" ? "查看串口日志确认细节。" : "Review serial logs for details.",
    key_evidence: [{ summary: options.replyLanguage === "zh" ? "串口日志可用" : "Serial log available", evidence_refs: ["serial.log"] }],
    confidence: 0.8,
  }));

  const llm = new LLMCallManager(mock, {
    planner: { model: "mock", timeout: 30 },
    observer: { model: "mock", timeout: 30 },
    reply: { model: "mock", timeout: 30 },
  });

  const events = [
    {
      type: "run_started",
      source: "run_manager",
      summary: "started",
      payload: {
        expected: "boot ok",
        success_criteria: ["serial says boot ok"],
        failure_signals: ["kernel panic"],
        reply_language: options.replyLanguage,
      },
    },
  ];

  const eventStore = {
    async read(): Promise<typeof events> {
      return events;
    },
  };
  const evidenceStore = {
    async getIndex(): Promise<{ refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] }> {
      return { refs: [{ ref: "serial.log", kind: "log", bytes: 128, available: true }], key_events: [] };
    },
    async readContent(): Promise<string> {
      return "boot ok\n";
    },
  };
  const runStore = {
    async get(): Promise<{ target_id: string; artifact: { path: string; type: string }; evidence_root: string }> {
      return { target_id: "board-1", artifact: { path: "/tmp/boot.img", type: "firmware" }, evidence_root: tmpDir };
    },
  };
  const memory = {
    async writeEpisode(): Promise<void> {},
    async writeProfile(): Promise<void> {},
    async getLatestProfile(): Promise<null> {
      return null;
    },
  };
  const emitted: Record<string, unknown>[] = [];
  const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore, memory, {
    emit: async (event) => {
      emitted.push(event);
    },
  }, tmpDir);

  return { reply, emitted };
}

describe("ReplyGenerator reply language", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  it("includes the requested language in normal reply context and result_ready", async () => {
    const { reply, emitted } = makeReplyGenerator({ replyLanguage: "zh" });

    const result = await reply.generate("run-zh");

    expect(result.summary).toContain("验证完成");
    const llmCall = emitted.find(event => event["type"] === "llm_call");
    expect(llmCall).toBeTruthy();
    const llmPayload = llmCall?.["payload"] as Record<string, unknown>;
    expect(String(llmPayload["input_preview"])).toContain("in Chinese");
    const resultReady = emitted.find(event => event["type"] === "result_ready");
    const resultPayload = resultReady?.["payload"] as Record<string, unknown>;
    expect(resultPayload["reply_language"]).toBe("zh");
  });

  it("uses Chinese fallback text for minimal replies when the run requested Chinese", async () => {
    const { reply, emitted } = makeReplyGenerator({ replyLanguage: "zh" });

    const result = await reply.generateMinimal("run-zh", "Failed to parse LLM reply");

    expect(result.summary).toContain("模型返回内容无法解析");
    expect(result.suggested_next).toBe("手动检查已采集的日志");
    const resultReady = emitted.find(event => event["type"] === "result_ready");
    const resultPayload = resultReady?.["payload"] as Record<string, unknown>;
    expect(resultPayload["reply_language"]).toBe("zh");
  });
});
