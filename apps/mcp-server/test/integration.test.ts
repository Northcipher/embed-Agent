import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/server.js";
import type { RuntimeClientPort } from "../src/tools.js";

describe("MCP server integration", () => {
  it("keeps output schemas for union-response tools and accepts successful variants", async () => {
    const client = await connectClient(
      fakeRuntimeClient({
        validateArtifact: async () =>
          ok({
            status: "accepted",
            run_id: "run-001",
            target: "board-01",
            state: "planning",
            evidence_path: "/tmp/run-001"
          }),
        getEvidence: async () =>
          ok({
            run_id: "run-001",
            partial: true,
            updated_at: "2026-04-29T00:00:00.000Z",
            root_path: "/tmp/run-001",
            refs: [{ ref: "serial:full", kind: "log", path: "/tmp/run-001/serial.log", available: true }],
            key_events: [{ seq: 1, summary: "serial captured", evidence_refs: ["serial:full"] }]
          }),
        getRunResult: async () =>
          ok({
            run_id: "run-001",
            status: "completed",
            summary: "validation completed",
            confidence: 0.9,
            key_evidence: [{ summary: "serial clean", evidence_refs: ["serial:full"] }],
            evidence_path: "/tmp/run-001"
          })
      })
    );

    const list = await client.listTools();

    for (const name of ["validate_artifact", "get_evidence", "get_run_result"]) {
      expect(list.tools.find(tool => tool.name === name)?.outputSchema).toBeDefined();
    }

    const validate = await client.callTool(
      {
        name: "validate_artifact",
        arguments: {
          context: { task: "验证启动", expected: "成功启动" },
          artifact: { path: "/tmp/firmware.img", type: "firmware_img" },
          target: "board-01",
          constraints: { max_duration_sec: 60 }
        }
      },
      CallToolResultSchema
    );
    expect(validate.isError).toBeUndefined();
    expect(validate.structuredContent).toMatchObject({ status: "accepted", run_id: "run-001" });

    const evidence = await client.callTool({ name: "get_evidence", arguments: { run_id: "run-001" } }, CallToolResultSchema);
    expect(evidence.isError).toBeUndefined();
    expect(evidence.structuredContent).toMatchObject({ run_id: "run-001", partial: true });

    const result = await client.callTool({ name: "get_run_result", arguments: { run_id: "run-001" } }, CallToolResultSchema);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ run_id: "run-001", status: "completed" });
  });

  it("accepts alternate union variants for the same MCP tools", async () => {
    const client = await connectClient(
      fakeRuntimeClient({
        validateArtifact: async () =>
          ok({
            status: "clarification_needed",
            target: "board-01",
            reasons: ["missing smoke command"],
            missing_info: ["context.test_hint.command"],
            suggested_next: "Provide an adb shell smoke command."
          }),
        getEvidence: async () =>
          ok({
            ref: "serial:full",
            kind: "log",
            path: "/tmp/run-001/serial.log",
            available: true,
            bytes: 512
          }),
        getRunResult: async () =>
          ok({
            run_id: "run-001",
            status: "running",
            result_available: false
          })
      })
    );

    const validate = await client.callTool(
      {
        name: "validate_artifact",
        arguments: {
          context: { task: "验证启动", expected: "成功启动" },
          artifact: { path: "/tmp/firmware.img", type: "firmware_img" },
          target: "board-01",
          constraints: { max_duration_sec: 60 }
        }
      },
      CallToolResultSchema
    );
    expect(validate.isError).toBeUndefined();
    expect(validate.structuredContent).toMatchObject({ status: "clarification_needed" });

    const evidence = await client.callTool({ name: "get_evidence", arguments: { run_id: "run-001", ref: "serial:full" } }, CallToolResultSchema);
    expect(evidence.isError).toBeUndefined();
    expect(evidence.structuredContent).toMatchObject({ ref: "serial:full", kind: "log" });

    const result = await client.callTool({ name: "get_run_result", arguments: { run_id: "run-001" } }, CallToolResultSchema);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ run_id: "run-001", result_available: false });
  });
});

function ok<T>(data: T) {
  return {
    ok: true as const,
    data
  };
}

function fakeRuntimeClient(overrides: Partial<RuntimeClientPort>): RuntimeClientPort {
  const notImplemented = async () => ({
    ok: false as const,
    error: {
      status: "error" as const,
      error_code: "internal_error" as const,
      message: "test client method not implemented"
    }
  });

  return {
    validateArtifact: overrides.validateArtifact ?? notImplemented,
    getRunStatus: overrides.getRunStatus ?? notImplemented,
    watchRun: overrides.watchRun ?? notImplemented,
    getRunEvents: overrides.getRunEvents ?? notImplemented,
    getEvidence: overrides.getEvidence ?? notImplemented,
    getRunResult: overrides.getRunResult ?? notImplemented,
    interveneRun: overrides.interveneRun ?? notImplemented,
    cancelRun: overrides.cancelRun ?? notImplemented,
    getTargetCapabilities: overrides.getTargetCapabilities ?? notImplemented
  };
}

async function connectClient(runtimeClient: RuntimeClientPort): Promise<Client> {
  const server = buildMcpServer({ client: runtimeClient });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}
