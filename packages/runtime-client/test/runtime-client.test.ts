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

    await client.getRunEvents({ run_id: "run/001", after_seq: 40, limit: 2, types: ["rule_matched", "observer_intent"] });
    await client.getEvidence({ run_id: "run/001", ref: "serial:full" });

    expect(calls[0]).toMatchObject({
      url: "http://runtime.local/api/runs/run%2F001/events?after_seq=40&limit=2&types=rule_matched%2Cobserver_intent",
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

  it("polls watch_run until new events arrive when wait_sec is positive", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let eventCallCount = 0;
    const client = new RuntimeHttpClient({
      baseUrl: "http://runtime.local/",
      watchPollIntervalMs: 5,
      sleepFn: async milliseconds => {
        sleeps.push(milliseconds);
      },
      fetchFn: async url => {
        const urlText = url.toString();
        calls.push(urlText);
        if (urlText.includes("/events")) {
          eventCallCount += 1;
          return new Response(
            JSON.stringify({
              run_id: "run-001",
              events:
                eventCallCount === 1
                  ? []
                  : [
                      {
                        seq: 8,
                        run_id: "run-001",
                        time: "2026-04-28T02:00:08.000Z",
                        elapsed_sec: 8,
                        type: "rule_matched",
                        severity: "warning",
                        source: "rule_engine",
                        summary: "panic signature matched"
                      }
                    ],
              next_after_seq: eventCallCount === 1 ? 7 : 8,
              has_more: false
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            run_id: "run-001",
            status: "running",
            target: {
              state: "busy",
              current_run_id: "run-001"
            },
            elapsed_sec: 9,
            last_event_seq: eventCallCount === 1 ? 7 : 8,
            evidence_path: "/tmp/runs/run-001"
          }),
          { status: 200 }
        );
      }
    });

    const result = await client.watchRun({
      run_id: "run-001",
      after_seq: 7,
      limit: 50,
      wait_sec: 1,
      types: ["rule_matched"]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        run_id: "run-001",
        status: "running",
        next_after_seq: 8
      });
      expect(result.data.events).toHaveLength(1);
    }
    expect(calls.filter(call => call.includes("/events"))).toHaveLength(2);
    expect(calls.filter(call => call.includes("/status"))).toHaveLength(2);
    expect(sleeps).toEqual([5]);
  });

  it("performs a single watch_run poll when wait_sec is zero", async () => {
    const calls: string[] = [];
    const client = new RuntimeHttpClient({
      baseUrl: "http://runtime.local/",
      sleepFn: async () => {
        throw new Error("watchRun should not sleep when wait_sec is zero");
      },
      fetchFn: async url => {
        const urlText = url.toString();
        calls.push(urlText);
        if (urlText.includes("/events")) {
          return new Response(
            JSON.stringify({
              run_id: "run-001",
              events: [],
              next_after_seq: 7,
              has_more: false
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            run_id: "run-001",
            status: "running",
            target: {
              state: "busy",
              current_run_id: "run-001"
            },
            elapsed_sec: 9,
            last_event_seq: 7,
            evidence_path: "/tmp/runs/run-001"
          }),
          { status: 200 }
        );
      }
    });

    const result = await client.watchRun({
      run_id: "run-001",
      after_seq: 7,
      limit: 50,
      wait_sec: 0
    });

    expect(result.ok).toBe(true);
    expect(calls.filter(call => call.includes("/events"))).toHaveLength(1);
    expect(calls.filter(call => call.includes("/status"))).toHaveLength(1);
  });

  it("stops watch_run polling when the wait deadline expires without new events", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let now = 0;
    const client = new RuntimeHttpClient({
      baseUrl: "http://runtime.local/",
      watchPollIntervalMs: 1000,
      nowFn: () => now,
      sleepFn: async milliseconds => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      fetchFn: async url => {
        const urlText = url.toString();
        calls.push(urlText);
        if (urlText.includes("/events")) {
          return new Response(
            JSON.stringify({
              run_id: "run-001",
              events: [],
              next_after_seq: 7,
              has_more: false
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            run_id: "run-001",
            status: "running",
            target: {
              state: "busy",
              current_run_id: "run-001"
            },
            elapsed_sec: 9,
            last_event_seq: 7,
            evidence_path: "/tmp/runs/run-001"
          }),
          { status: 200 }
        );
      }
    });

    const result = await client.watchRun({
      run_id: "run-001",
      after_seq: 7,
      limit: 50,
      wait_sec: 1
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.events).toEqual([]);
      expect(result.data.next_after_seq).toBe(7);
    }
    expect(calls.filter(call => call.includes("/events"))).toHaveLength(2);
    expect(calls.filter(call => call.includes("/status"))).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
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
