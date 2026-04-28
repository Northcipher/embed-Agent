import { describe, expect, it } from "vitest";
import { RuntimeHttpClient, type FetchLike } from "../src/index.js";

describe("RuntimeHttpClient", () => {
  it("posts validate_artifact to Runtime HTTP API and parses contract output", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new RuntimeHttpClient({
      baseUrl: "http://runtime.local",
      fetchFn: recordFetch(calls, {
        status: "accepted",
        run_id: "run-001",
        target: "board-01",
        state: "planning",
        evidence_path: "/tmp/runs/run-001"
      })
    });

    const result = await client.validateArtifact(validValidateArtifactInput());

    expect(result).toEqual({
      ok: true,
      data: {
        status: "accepted",
        run_id: "run-001",
        target: "board-01",
        state: "planning",
        evidence_path: "/tmp/runs/run-001"
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://runtime.local/api/validate-artifact",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json"
        }
      }
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      target: "board-01",
      context: {
        test_hint: {
          command: "/vendor/bin/smoke_test"
        }
      }
    });
  });

  it("maps public Runtime HTTP errors to client errors without throwing", async () => {
    const client = new RuntimeHttpClient({
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            status: "error",
            error_code: "run_not_found",
            message: "run run-missing was not found"
          }),
          { status: 404 }
        )
    });

    await expect(client.getRunStatus({ run_id: "run-missing" })).resolves.toEqual({
      ok: false,
      error: {
        status: "error",
        error_code: "run_not_found",
        message: "run run-missing was not found"
      }
    });
  });

  it("rejects non-contract Runtime responses as internal errors", async () => {
    const client = new RuntimeHttpClient({
      fetchFn: recordFetch([], {
        unexpected: true
      })
    });

    const result = await client.getRunStatus({ run_id: "run-001" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: "error",
        error_code: "internal_error"
      });
      expect(result.error.message).toContain("Runtime API response did not match contract");
    }
  });

  it("builds encoded GET URLs for event cursors and evidence refs", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new RuntimeHttpClient({
      baseUrl: "http://runtime.local/",
      fetchFn: async (url, init) => {
        calls.push({
          url: url.toString(),
          init
        });
        if (url.toString().includes("/events")) {
          return new Response(
            JSON.stringify({
              run_id: "run/001",
              events: [],
              next_after_seq: 42,
              has_more: false
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            ref: "serial:full",
            kind: "log",
            path: "/tmp/runs/run-001/serial.log",
            available: true,
            bytes: 1024
          }),
          { status: 200 }
        );
      }
    });

    await client.getRunEvents({ run_id: "run/001", after_seq: 40, limit: 2 });
    await client.getEvidence({ run_id: "run/001", ref: "serial:full" });

    expect(calls[0]).toMatchObject({
      url: "http://runtime.local/api/runs/run%2F001/events?after_seq=40&limit=2",
      init: {
        method: "GET"
      }
    });
    expect(calls[1]).toMatchObject({
      url: "http://runtime.local/api/runs/run%2F001/evidence?ref=serial%3Afull",
      init: {
        method: "GET"
      }
    });
  });
});

function recordFetch(calls: Array<{ url: string; init: RequestInit | undefined }>, body: unknown): FetchLike {
  return async (url, init) => {
    calls.push({
      url: url.toString(),
      init
    });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

function validValidateArtifactInput() {
  return {
    context: {
      task: "验证 boot crash 是否修复",
      what_changed: "调整 init service 启动顺序",
      expected: "设备能启动完成，ADB 能回来",
      concerns: ["kernel panic"],
      test_hint: {
        kind: "adb_shell" as const,
        command: "/vendor/bin/smoke_test",
        timeout_sec: 60,
        expected_exit_code: 0
      }
    },
    artifact: {
      path: "/tmp/firmware.img",
      type: "firmware_img"
    },
    target: "board-01",
    constraints: {
      max_duration_sec: 600,
      allow_flash: true,
      allow_reboot: true
    }
  };
}
