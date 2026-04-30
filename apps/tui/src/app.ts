import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput } from "ink";

interface ViewsLike {
  targets(): Promise<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]>;
  status(runId: string): Promise<{ run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number } | null>;
}

interface AppProps {
  views: ViewsLike;
  refreshMs?: number;
}

function App({ views, refreshMs = 5000 }: AppProps) {
  const [targets, setTargets] = useState<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]>([]);
  const [selectedTab, setSelectedTab] = useState<"targets" | "help">("targets");

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const t = await views.targets();
        if (active) setTargets(t);
      } catch { /* views unavailable */ }
    };
    poll();
    const timer = setInterval(poll, refreshMs);
    return () => { active = false; clearInterval(timer); };
  }, [refreshMs]);

  useInput((input, key) => {
    if (input === "q") process.exit(0);
    if (input === "t") setSelectedTab("targets");
    if (input === "h") setSelectedTab("help");
    if (key.escape) process.exit(0);
  });

  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, "Embed Agent TUI"),
    React.createElement(Text, { dimColor: true }, "t: Targets | h: Help | q/ESC: Quit"),
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
          React.createElement(Text, {}, `  state=${t.state}  serial=${t.serial}  adb=${t.adb}  fastboot=${t.fastboot}${t.current_run_id ? `  run=${t.current_run_id}` : ""}`),
        ),
      ),
      targets.length === 0 && React.createElement(Text, { dimColor: true }, "  No targets configured"),
    ),
    selectedTab === "help" && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Keyboard Shortcuts"),
      React.createElement(Text, {}, "  t       — Targets overview"),
      React.createElement(Text, {}, "  h       — This help"),
      React.createElement(Text, {}, "  q / ESC — Quit"),
      React.createElement(Box, { marginTop: 1 }),
      React.createElement(Text, { dimColor: true }, "Full implementation requires EventBus SSE subscription for live updates."),
    ),
  );
}

export function startTui(views: ViewsLike, refreshMs = 5000): void {
  const { unmount } = render(React.createElement(App, { views, refreshMs }));
  process.on("SIGINT", () => { unmount(); process.exit(0); });
}
