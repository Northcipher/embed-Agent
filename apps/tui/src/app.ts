import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput } from "ink";

interface ViewsLike {
  targets(): Promise<{ target_id: string; state: string; serial: string; adb: string; current_run_id?: string }[]>;
  status(runId: string): Promise<{ run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; evidence_path: string } | null>;
  result(runId: string): Promise<{ run_id: string; state: string; result_available: boolean; summary?: string; evidence_path?: string }>;
}

interface AppProps {
  views: ViewsLike;
  refreshMs?: number;
}

type Tab = "targets" | "runs" | "help";

function App({ views, refreshMs = 5000 }: AppProps) {
  const [targets, setTargets] = useState<{ target_id: string; state: string; serial: string; adb: string; current_run_id?: string }[]>([]);
  const [selectedTab, setSelectedTab] = useState<Tab>("targets");
  const [viewedRun, setViewedRun] = useState("");
  const [runStatus, setRunStatus] = useState<{ run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number } | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try { const t = await views.targets(); if (active) setTargets(t); } catch { /* views unavailable */ }
      if (viewedRun) {
        try { const s = await views.status(viewedRun); if (active && s) setRunStatus(s); } catch {}
      }
    };
    poll();
    const timer = setInterval(poll, refreshMs);
    return () => { active = false; clearInterval(timer); };
  }, [refreshMs, viewedRun]);

  useInput((input) => {
    if (input === "q") process.exit(0);
    if (input === "t") { setSelectedTab("targets"); setViewedRun(""); }
    if (input === "r") setSelectedTab("runs");
    if (input === "h") setSelectedTab("help");
  });

  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, "Embed Agent TUI"),
    React.createElement(Text, { dimColor: true }, "t: Targets | r: Runs | h: Help | q: Quit"),
    React.createElement(Box, { marginTop: 1 }),

    selectedTab === "targets" && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Targets"),
      ...targets.map(t =>
        React.createElement(
          Box,
          { key: t.target_id },
          React.createElement(Text, { color: t.state === "busy" ? "yellow" : t.state === "offline" ? "red" : "green" }, `  ${t.target_id}`),
          React.createElement(Text, {}, `  state=${t.state}  serial=${t.serial}  adb=${t.adb}${t.current_run_id ? `  run=${t.current_run_id}` : ""}`),
        ),
      ),
      targets.length === 0 && React.createElement(Text, { dimColor: true }, "  No targets configured"),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "Type a run ID to view: r <run-id>"),
    ),
    selectedTab === "runs" && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Active Runs"),
      ...targets.filter(t => t.current_run_id).map(t => {
        const stateColor = t.state === "busy" ? "yellow" : "green";
        return React.createElement(Text, { key: t.target_id, color: stateColor }, `  ${t.current_run_id}  target=${t.target_id}  state=${t.state}`);
      }),
      targets.filter(t => t.current_run_id).length === 0 && React.createElement(Text, { dimColor: true }, "  No active runs"),
      viewedRun && runStatus && React.createElement(
        Box,
        { flexDirection: "column", marginTop: 1 },
        React.createElement(Text, { bold: true }, `Run Detail: ${viewedRun}`),
        React.createElement(Text, {}, `  state=${runStatus.state}  elapsed=${runStatus.elapsed_sec}s${runStatus.current_step ? `  step=${runStatus.current_step.id}` : ""}`),
      ),
    ),
    selectedTab === "help" && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Keyboard Shortcuts"),
      React.createElement(Text, {}, "  t       — Targets overview"),
      React.createElement(Text, {}, "  r       — Active runs"),
      React.createElement(Text, {}, "  h       — This help"),
      React.createElement(Text, {}, "  q       — Quit"),
    ),
  );
}

export function startTui(views: ViewsLike, refreshMs = 5000): void {
  const { unmount } = render(React.createElement(App, { views, refreshMs }));
  process.on("SIGINT", () => { unmount(); process.exit(0); });
}
