import { useState, useEffect } from "react";
import { api } from "./api";
import { Header, Badge } from "./Dashboard";
import { useT } from "./i18n";

interface RunInfo { run_id: string; target: string; state: string; elapsed_sec: number; summary?: string; }

export function History({ onViewRun }: { onViewRun: (id: string) => void }) {
  const { t } = useT();
  const [runs, setRuns] = useState<RunInfo[]>([]);

  useEffect(() => {
    api.targets().then(ts => {
      ts.forEach(t2 => {
        if (!t2.current_run_id) return;
        api.status(t2.current_run_id).then(s => {
          if (s) setRuns(prev => [...prev.filter(r => r.run_id !== s.run_id), { run_id: s.run_id, target: t2.target_id, state: s.state, elapsed_sec: s.elapsed_sec, summary: s.state }]);
        }).catch(() => {});
      });
    });
  }, []);

  const hdrs = ["run.table.run","run.table.target","run.table.state","run.table.time","run.table.summary"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Header title={t("history.title")} />
      {runs.length === 0 ? <div style={{ color: "var(--fg-tertiary)", fontSize: 13 }}>{t("history.empty")}</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{hdrs.map(h => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: "var(--fg-tertiary)", fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: ".5px", borderBottom: "1px solid var(--border)" }}>{t(h)}</th>)}</tr></thead>
          <tbody>
            {runs.map(r => {
              const v = r.state === "completed" ? "pass" : r.state === "failed" ? "fail" : "running";
              return (
                <tr key={r.run_id} onClick={() => onViewRun(r.run_id)} style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 14px", fontSize: 13, fontFamily: "var(--font-mono)" }}>{r.run_id}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.target}</td>
                  <td style={{ padding: "10px 14px" }}><Badge tone={v}>{t(`badge.${v}`)}</Badge></td>
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
