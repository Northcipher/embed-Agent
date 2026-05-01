import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput } from "ink";
import type { CommandHandler } from "@embed-agent/cli";

type View = "dashboard" | "feed" | "result" | "evidence" | "start-run" | "help";

interface TargetInfo { target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string; }
interface EventInfo { seq: number; type: string; severity?: string; summary: string; time: string; }
interface RunStatusInfo { run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; }
interface ResultInfo { state: string; result_available: boolean; summary?: string; suggested_next?: string; key_evidence?: { summary: string; evidence_refs: string[] }[]; criteria_results?: { criterion: string; status: string; evidence_refs: string[] }[]; confidence?: number; }
interface EvidenceInfo { available: boolean; content?: string; index?: { refs: { ref: string; kind: string; bytes?: number }[] } }

const EVENTS_OF_INTEREST = new Set([
  "run_started", "step_started", "step_completed", "step_failed",
  "rule_matched", "decision_made", "result_ready", "llm_call",
  "run_paused", "run_resumed", "run_completed", "run_failed", "run_cancelled",
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
  const [selectedEventIdx, setSelectedEventIdx] = useState(-1);

  // Evidence
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [evidenceText, setEvidenceText] = useState("");

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
          const page = await handler.events(activeRunId, afterSeqRef.current, 100);
          if (active && page.events.length > 0) {
            const filtered = page.events.filter(e => EVENTS_OF_INTEREST.has(e.type));
            setEvents(prev => [...prev, ...filtered].slice(-500));
            afterSeqRef.current = page.next_after_seq;
          }
          const s = await handler.status(activeRunId);
          if (active && s) setRunStatus(s);
        } catch { /* run gone */ }
      }
    };
    poll();
    const timer = setInterval(poll, view === "feed" ? 1000 : 5000);
    return () => { active = false; clearInterval(timer); };
  }, [view, activeRunId]);

  // --- Input ---
  useInput((char, key) => {
    // Form mode: text input
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

    // Global
    if (char === "q") process.exit(0);
    if (char === "h") { setView("help"); return; }
    if (key.escape) { setView("dashboard"); return; }

    // Dashboard
    if (view === "dashboard") {
      if (key.upArrow) setSelectedIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedIdx(i => Math.min(targets.length - 1, i + 1));
      if (key.return && targets[selectedIdx]?.current_run_id) {
        enterFeed(targets[selectedIdx]!.current_run_id!);
      }
      if (char === "s") {
        setFormTarget(targets[selectedIdx]?.target_id ?? "");
        setView("start-run");
      }
      return;
    }

    // Feed
    if (view === "feed") {
      if (char === "p") {
        handler.pause(activeRunId, "manual").then(() => setFeedMsg("Paused"), (e) => setFeedMsg(`Pause failed: ${(e as Error).message}`));
      }
      if (char === "c") {
        handler.cancel(activeRunId, "manual").then(() => setFeedMsg("Cancelled"), (e) => setFeedMsg(`Cancel failed: ${(e as Error).message}`));
      }
      if (char === "x") {
        handler.resume(activeRunId).then(() => setFeedMsg("Resumed"), (e) => setFeedMsg(`Resume failed: ${(e as Error).message}`));
      }
      if (char === "r") showResult();
      if (char === "e") peekEvidence();
      if (key.upArrow) setSelectedEventIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedEventIdx(i => Math.min(events.length - 1, i + 1));
      return;
    }
  });

  async function enterFeed(runId: string) {
    setView("feed"); setActiveRunId(runId); setEvents([]); afterSeqRef.current = 0;
    setSelectedEventIdx(-1); setRunStatus(null); setFeedMsg("");
  }
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
    const ev = events[selectedEventIdx];
    if (!ev) { setEvidenceTitle("(no event selected)"); setEvidenceText("Select an event with ↑↓ first"); setView("evidence"); return; }
    const idx = await handler.evidence(activeRunId);
    setEvidenceTitle(`Evidence for: [${ev.type}] ${ev.summary}`);
    if (idx.available && idx.index?.refs?.length) {
      const firstRef = idx.index.refs[0]!.ref;
      const content = await handler.evidence(activeRunId, firstRef);
      setEvidenceText(content.content ?? "(empty)");
    } else {
      setEvidenceText("No evidence available for this run.");
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
      React.createElement(Text, { bold: true, color: "cyan" }, "Keyboard Shortcuts"),
      React.createElement(Text, {}, "  ↑↓      — Navigate  /  enter — Select"),
      React.createElement(Text, {}, "  s       — Start run"),
      React.createElement(Text, {}, "  e       — Evidence peek (in feed)"),
      React.createElement(Text, {}, "  p       — Pause run / c — Cancel"),
      React.createElement(Text, {}, "  r       — Show result"),
      React.createElement(Text, {}, "  h       — Help  /  esc — Back"),
      React.createElement(Text, {}, "  q       — Quit"),
    );
  }

  if (view === "feed") {
    const recent = events.slice(-50);
    const hasTerminal = runStatus && ["completed", "failed", "cancelled"].includes(runStatus.state);
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, `Run ${activeRunId}`),
      React.createElement(Text, { color: stateColor(runStatus?.state) },
        `${runStatus?.state ?? "?"}  ${runStatus?.elapsed_sec ?? 0}s${runStatus?.current_step ? `  step=${runStatus.current_step.id}` : ""}`),
      hasTerminal && React.createElement(Text, { color: "yellow", bold: true }, "Run finished. Press r for result."),
      feedMsg && React.createElement(Text, { color: "green" }, feedMsg),
      React.createElement(Box, { marginTop: 1 }),
      ...recent.map((e, i) => {
        const isSelected = i === (selectedEventIdx >= 0 ? selectedEventIdx - (events.length - recent.length) : -1);
        const prefix = isSelected ? "▶" : " ";
        return React.createElement(Text, { key: e.seq, color: severityColor(e.severity) },
          `${prefix} seq=${e.seq}  [${e.type}] ${e.summary.slice(0, 80)}`);
      }),
      recent.length === 0 && React.createElement(Text, { dimColor: true }, "Waiting for events..."),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "↑↓:select  e:evidence  p:pause  x:resume  c:cancel  r:result  esc:back"),
    );
  }

  // Dashboard
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
