import { useState, useEffect } from "react";
import { api, type Target } from "./api";
import { Header, Badge } from "./Dashboard";

interface RunInfo { run_id: string; target: string; state: string; elapsed_sec: number; summary?: string; }

export function History({ onViewRun }: { onViewRun: (id: string) => void }) {
  const [runs, setRuns] = useState<RunInfo[]>([]);

  useEffect(() => {
    api.targets().then(ts => {
      ts.forEach(t => {
        if (!t.current_run_id) return;
        api.status(t.current_run_id).then(s => {
          if (s) setRuns(prev => [...prev.filter(r => r.run_id !== s.run_id), { run_id: s.run_id, target: t.target_id, state: s.state, elapsed_sec: s.elapsed_sec, summary: s.state }]);
        }).catch(() => {});
      });
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Header title="History" />
      {runs.length === 0 ? <div style={{ color: "var(--fg-tertiary)", fontSize: 13 }}>No runs found. Start the HTTP Runtime server and create a run.</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Run", "Target", "State", "Time", "Summary"].map(h => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: "var(--fg-tertiary)", fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: ".5px", borderBottom: "1px solid var(--border)" }}>{h}</th>)}</tr></thead>
          <tbody>
            {runs.map(r => {
              const v = r.state === "completed" ? "pass" : r.state === "failed" ? "fail" : "running";
              return (
                <tr key={r.run_id} onClick={() => onViewRun(r.run_id)} style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 14px", fontSize: 13, fontFamily: "var(--font-mono)" }}>{r.run_id}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.target}</td>
                  <td style={{ padding: "10px 14px" }}><Badge tone={v as any}>{r.state.toUpperCase()}</Badge></td>
                  <td style={{ padding: "10px 14px", fontSize: 13, fontFamily: "var(--font-mono)" }}>{r.elapsed_sec}s</td>
                  <td style={{ padding: "10px 14px", fontSize: 13, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-secondary)" }}>{r.summary ?? r.state}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
