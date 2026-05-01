import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput } from "ink";
import type { CommandHandler } from "@embed-agent/cli";

type View = "dashboard" | "feed" | "result" | "evidence" | "start-run" | "help";

interface TargetInfo { target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string; }
interface EventInfo { seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; }
interface RunStatusInfo { run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; }
interface ResultInfo { state: string; result_available: boolean; summary?: string; suggested_next?: string; key_evidence?: { summary: string; evidence_refs: string[] }[]; criteria_results?: { criterion: string; status: string; evidence_refs: string[] }[]; confidence?: number; }

// Step status derived from events
interface StepSummary {
  id: string;
  command?: string;
  status: "running" | "ok" | "failed" | "skipped";
  hasWarning: boolean;
  hasFatal: boolean;
  evidenceBytes?: number;
  reason?: string;
}

// Only aggregate step-level events; hide noise (llm_call, observation, evidence_collected, target_state_changed)
const STEP_EVENTS = new Set([
  "step_started", "step_completed", "step_failed", "rule_matched",
  "run_started", "run_completed", "run_failed", "run_cancelled",
  "run_paused", "run_resumed", "result_ready", "decision_made",
]);

const SEVERITY_COLORS: Record<string, string> = {
  fatal: "red", warning: "yellow", info: "white",
};
const STATE_COLORS: Record<string, string> = {
  busy: "yellow", running: "yellow", connected: "green", online: "green",
  idle: "green", offline: "red", disconnected: "red",
  completed: "green", failed: "red", cancelled: "yellow",
};

function severityColor(s?: string) { return SEVERITY_COLORS[s ?? "info"] ?? "white"; }
function stateColor(s?: string) { return STATE_COLORS[s ?? ""] ?? "white"; }

/** Derive step summaries from raw events. */
function buildStepSummaries(events: EventInfo[]): StepSummary[] {
  const steps = new Map<string, StepSummary>();
  // Track evidence size from evidence_collected events
  const evidenceSizes = new Map<string, number>();

  for (const e of events) {
    if (e.type === "evidence_collected") {
      // Parse bytes from summary like "Evidence step-check-ssh:full written (129 bytes)"
      const m = e.summary.match(/\((\d+) bytes\)/);
      if (m && e.step_id) evidenceSizes.set(e.step_id, parseInt(m[1]!, 10));
    }
  }

  for (const e of events) {
    if (e.type === "step_started") {
      const sid = e.step_id ?? e.summary.replace("Step ", "").split(" ")[0] ?? "?";
      // Extract command from summary: "Step check-ssh started" → "check-ssh"
      const id = sid;
      const step: StepSummary = { id, status: "running", hasWarning: false, hasFatal: false };
      const eb = evidenceSizes.get(sid);
      if (eb != null) step.evidenceBytes = eb;
      steps.set(id, step);
    }
    if (e.type === "step_completed") {
      const sid = e.step_id ?? "?";
      const s = steps.get(sid);
      if (s) {
        s.status = "ok";
        const ebs = evidenceSizes.get(sid);
        if (ebs != null) s.evidenceBytes = ebs;
      }
    }
    if (e.type === "step_failed") {
      const sid = e.step_id ?? "?";
      const s = steps.get(sid);
      if (s) { s.status = "failed"; s.reason = e.summary; }
    }
    if (e.type === "rule_matched" && e.step_id) {
      const s = steps.get(e.step_id);
      if (s) {
        if (e.severity === "fatal") s.hasFatal = true;
        if (e.severity === "warning") s.hasWarning = true;
      }
    }
  }

  // Mark steps after a failed step as skipped
  let foundFailed = false;
  const result: StepSummary[] = [];
  for (const [, s] of steps) {
    if (foundFailed && s.status === "running") s.status = "skipped";
    if (s.status === "failed") foundFailed = true;
    result.push(s);
  }
  return result;
}

function stepIcon(s: StepSummary): string {
  if (s.hasFatal) return "🔴";
  if (s.hasWarning && s.status === "ok") return "⚠";
  if (s.status === "ok") return "✓";
  if (s.status === "failed") return "✗";
  if (s.status === "skipped") return "·";
  return "◌"; // running
}

function stepColor(s: StepSummary): string {
  if (s.hasFatal) return "red";
  if (s.hasWarning) return "yellow";
  if (s.status === "ok") return "green";
  if (s.status === "failed") return "red";
  if (s.status === "skipped") return "grey";
  return "white"; // running
}

function App({ handler }: { handler: CommandHandler }) {
  const [view, setView] = useState<View>("dashboard");
  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Feed
  const [activeRunId, setActiveRunId] = useState("");
  const [events, setEvents] = useState<EventInfo[]>([]);
  const afterSeqRef = useRef(0);
  const [runStatus, setRunStatus] = useState<RunStatusInfo | null>(null);
  const [feedMsg, setFeedMsg] = useState("");

  // Evidence
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [evidenceText, setEvidenceText] = useState("");

  // Live log — tail of current stream step's evidence
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [liveLogRef, setLiveLogRef] = useState("");

  // Result
  const [result, setResult] = useState<ResultInfo | null>(null);

  // Start-run form
  const [formTarget, setFormTarget] = useState("");
  const [formPath, setFormPath] = useState("");
  const [formExpected, setFormExpected] = useState("");
  const [formField, setFormField] = useState<0 | 1 | 2>(0);
  const [formMsg, setFormMsg] = useState("");

  // --- Polling ---
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (view === "dashboard") {
        try { const t = await handler.targetList(); if (active) setTargets(t); } catch {}
      }
      if (view === "feed" && activeRunId) {
        try {
          const page = await handler.events(activeRunId, afterSeqRef.current, 200);
          if (active && page.events.length > 0) {
            // Collect ALL events (need evidence_collected for byte counts, step events for aggregation)
            setEvents(prev => [...prev, ...page.events].slice(-1000));
            afterSeqRef.current = page.next_after_seq;
          }
          const s = await handler.status(activeRunId);
          if (active && s) {
            setRunStatus(s);
            // If current step is a stream, tail its evidence for live log
            if (s.current_step?.id) {
              const ref = `step-${s.current_step.id}:full`;
              if (ref !== liveLogRef) { setLiveLog([]); setLiveLogRef(ref); }
              try {
                const ev = await handler.evidence(activeRunId, ref);
                if (ev.available && ev.content) {
                  const lines = ev.content.split("\n").filter(Boolean);
                  setLiveLog(lines.slice(-15)); // last 15 lines
                }
              } catch { /* evidence not ready yet */ }
            } else {
              setLiveLog([]); setLiveLogRef("");
            }
          }
        } catch { /* run gone */ }
      }
    };
    poll();
    const timer = setInterval(poll, view === "feed" ? 1000 : 5000);
    return () => { active = false; clearInterval(timer); };
  }, [view, activeRunId, liveLogRef]);

  // --- Input ---
  useInput((char, key) => {
    if (view === "start-run") {
      if (key.escape) { setView("dashboard"); clearForm(); return; }
      if (key.tab) { setFormField(((formField + 1) % 3) as 0|1|2); return; }
      if (key.return) { submitRun(); return; }
      if (key.backspace || key.delete) {
        if (formField === 0) setFormTarget(t => t.slice(0, -1));
        else if (formField === 1) setFormPath(p => p.slice(0, -1));
        else setFormExpected(e => e.slice(0, -1));
        return;
      }
      if (char) {
        if (formField === 0) setFormTarget(t => t + char);
        else if (formField === 1) setFormPath(p => p + char);
        else setFormExpected(e => e + char);
      }
      return;
    }
    if (char === "q") process.exit(0);
    if (char === "h") { setView("help"); return; }
    if (key.escape) { setView("dashboard"); return; }
    if (view === "dashboard") {
      if (key.upArrow) setSelectedIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedIdx(i => Math.min(targets.length - 1, i + 1));
      if (key.return && targets[selectedIdx]?.current_run_id) enterFeed(targets[selectedIdx]!.current_run_id!);
      if (char === "s") { setFormTarget(targets[selectedIdx]?.target_id ?? ""); setView("start-run"); }
      return;
    }
    if (view === "feed") {
      if (char === "p") handler.pause(activeRunId, "manual").then(() => setFeedMsg("Paused"), (e) => setFeedMsg(`Pause failed: ${(e as Error).message}`));
      if (char === "c") handler.cancel(activeRunId, "manual").then(() => setFeedMsg("Cancelled"), (e) => setFeedMsg(`Cancel failed: ${(e as Error).message}`));
      if (char === "x") handler.resume(activeRunId).then(() => setFeedMsg("Resumed"), (e) => setFeedMsg(`Resume failed: ${(e as Error).message}`));
      if (char === "r") showResult();
      if (char === "e") peekEvidence();
      return;
    }
  });

  async function enterFeed(runId: string) { setView("feed"); setActiveRunId(runId); setEvents([]); afterSeqRef.current = 0; setRunStatus(null); setFeedMsg(""); setLiveLog([]); setLiveLogRef(""); }
  function clearForm() { setFormTarget(""); setFormPath(""); setFormExpected(""); setFormField(0); setFormMsg(""); }
  async function submitRun() {
    if (!formTarget || !formPath) { setFormMsg("Target and path required"); return; }
    const r = await handler.validate({
      artifact: { path: formPath, type: "firmware" },
      target: formTarget,
      expected: formExpected || "Device operates normally",
    } as Parameters<typeof handler.validate>[0]);
    if (r.status === "accepted") { clearForm(); enterFeed(r.run_id!); }
    else setFormMsg(`${r.status}: ${r.reasons?.join(", ") ?? "see logs"}`);
  }
  async function showResult() {
    const r = await handler.result(activeRunId);
    setResult(r as ResultInfo); setView("result");
  }
  async function peekEvidence() {
    const idx = await handler.evidence(activeRunId);
    if (idx.available && idx.index?.refs?.length) {
      const ref = idx.index.refs[0]!.ref;
      const content = await handler.evidence(activeRunId, ref);
      setEvidenceTitle(`Evidence: ${ref}`);
      setEvidenceText(content.content ?? "(empty)");
    } else {
      setEvidenceTitle("No evidence"); setEvidenceText("No evidence available for this run.");
    }
    setView("evidence");
  }

  // ============================================================
  // Render
  // ============================================================

  if (view === "evidence") {
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "Evidence"),
      React.createElement(Text, { dimColor: true }, evidenceTitle),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, {}, evidenceText.slice(0, 5000)),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "esc: back  q: quit"),
    );
  }

  if (view === "result") {
    const r = result;
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, `Run ${activeRunId}`),
      React.createElement(Text, { color: stateColor(r?.state) }, `Verdict: ${r?.state?.toUpperCase() ?? "?"}`),
      r?.summary && React.createElement(Text, {}, r.summary),
      r?.criteria_results && React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, "Criteria:"),
        ...r.criteria_results.map(c =>
          React.createElement(Text, { key: c.criterion, color: c.status === "pass" ? "green" : c.status === "fail" ? "red" : "yellow" },
            `  ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "?"} ${c.criterion}`)
        ),
      ),
      r?.key_evidence && r.key_evidence.length > 0 && React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, "Key Evidence:"),
        ...r.key_evidence.map(ke => React.createElement(Text, { key: ke.summary, dimColor: true }, `  • ${ke.summary}`)),
      ),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "esc: dashboard  q: quit"),
    );
  }

  if (view === "start-run") {
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "Start Run"),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, {}, `Target:    ${formTarget}${formField === 0 ? "█" : ""}`),
      React.createElement(Text, {}, `Artifact:  ${formPath}${formField === 1 ? "█" : ""}`),
      React.createElement(Text, {}, `Expected:  ${formExpected}${formField === 2 ? "█" : ""}`),
      formMsg && React.createElement(Text, { color: "red" }, formMsg),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "tab: next field  enter: start  esc: cancel"),
    );
  }

  if (view === "help") {
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "Embed Agent TUI"),
      React.createElement(Text, {}, "  ↑↓     — Navigate"),
      React.createElement(Text, {}, "  enter  — View run / s — Start run"),
      React.createElement(Text, {}, "  p      — Pause  /  x — Resume  /  c — Cancel"),
      React.createElement(Text, {}, "  r      — Result  /  e — Evidence"),
      React.createElement(Text, {}, "  esc    — Back  /  q — Quit"),
    );
  }

  // ============================================================
  // FEED — step-level summary with colors
  // ============================================================
  if (view === "feed") {
    const steps = buildStepSummaries(events);
    const terminal = ["completed", "failed", "cancelled"].includes(runStatus?.state ?? "");
    const passedCount = steps.filter(s => s.status === "ok").length;
    const bar = steps.map(s => {
      if (s.hasFatal) return "▇";
      if (s.status === "ok") return "▇";
      if (s.status === "failed") return "▇";
      if (s.status === "running") return "▇";
      return "·";
    }).join("");

    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      // Header
      React.createElement(Text, { bold: true, color: "cyan" }, `Run ${activeRunId}`),
      React.createElement(Text, { color: stateColor(runStatus?.state) },
        `${runStatus?.state ?? "?"}  ${runStatus?.elapsed_sec ?? 0}s${runStatus?.current_step ? `  step=${runStatus.current_step.id}` : ""}`),
      React.createElement(Box, { marginTop: 1 }),

      // Step summary — the main view
      ...steps.map(s => React.createElement(Text, { key: s.id, color: stepColor(s) },
        `${stepIcon(s)} ${s.id.slice(0, 28).padEnd(28)} ${(s.command ?? "").slice(0, 24).padEnd(24)} ${s.status === "failed" ? (s.reason ?? "").slice(0, 40) : s.evidenceBytes ? `${s.evidenceBytes}B evidence` : ""}`,
      )),
      steps.length === 0 && React.createElement(Text, { dimColor: true }, "Waiting for steps..."),

      // Progress bar
      steps.length > 0 && React.createElement(Box, { marginTop: 1, flexDirection: "row" },
        React.createElement(Text, { color: terminal ? stateColor(runStatus?.state) : "white" },
          `${bar}  ${passedCount}/${steps.length} passed`),
      ),

      // Live log: tail of current stream step's evidence
      liveLog.length > 0 && React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { dimColor: true, bold: true }, `── log tail (${liveLog.length} lines) ──`),
        ...liveLog.map((line, i) => {
          const isWarning = /warn|error|fail|panic|oom|fatal/i.test(line);
          const isFatal = /panic|fatal|kernel bug/i.test(line);
          return React.createElement(Text, {
            key: i,
            color: isFatal ? "red" : isWarning ? "yellow" : "white",
            dimColor: !isWarning,
          }, line.slice(0, 120));
        }),
      ),

      // Transient events (only rule_matched, decision_made, run_paused/resumed)
      React.createElement(Box, { marginTop: 1 }),
      ...events.filter(e => ["rule_matched", "decision_made", "run_paused", "run_resumed", "result_ready"].includes(e.type)).slice(-3).map(e =>
        React.createElement(Text, { key: e.seq, color: severityColor(e.severity), dimColor: e.type === "result_ready" },
          `  [${e.type}] ${e.summary.slice(0, 80)}`),
      ),

      terminal && React.createElement(Text, { color: stateColor(runStatus?.state), bold: true }, "Run finished. Press r for result."),
      feedMsg && React.createElement(Text, { color: "green" }, feedMsg),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "e:evidence  p:pause  x:resume  c:cancel  r:result  esc:back"),
    );
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  const busyCount = targets.filter(t => !!t.current_run_id).length;
  return React.createElement(Box, { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, `Embed Agent  —  ${targets.length} targets, ${busyCount} active`),
    React.createElement(Box, { marginTop: 1 }),
    React.createElement(Text, { bold: true }, "Targets"),
    ...targets.map((t, i) => {
      const isSelected = i === selectedIdx;
      return React.createElement(Box, { key: t.target_id },
        React.createElement(Text, { color: isSelected ? "blue" : stateColor(t.current_run_id ? "busy" : "idle") },
          `${isSelected ? "▶" : " "} ${t.target_id}  state=${t.state}  serial=${t.serial}  adb=${t.adb}${t.current_run_id ? `  run=${t.current_run_id}` : ""}`),
      );
    }),
    targets.length === 0 && React.createElement(Text, { dimColor: true }, "  No targets configured."),
    React.createElement(Box, { marginTop: 1 }),
    React.createElement(Text, { dimColor: true }, "↑↓:select  enter:view run  s:start run  h:help  q:quit"),
  );
}

export function startTui(handler: CommandHandler): void {
  const { unmount } = render(React.createElement(App, { handler }));
  process.on("SIGINT", () => { unmount(); process.exit(0); });
}
