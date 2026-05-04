import { useState, useEffect } from "react";
import { api, type Target } from "./api";
import { useT } from "./i18n";

export function Dashboard({ onViewRun, onStart }: { onViewRun: (id: string) => void; onStart: () => void }) {
  const { t } = useT();
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<any[]>([]);

  useEffect(() => {
    api.targets().then(setTargets).catch(() => {});
    api.targets().then(ts => {
      ts.filter(t => t.current_run_id).forEach(t => {
        api.status(t.current_run_id!).then(s => {
          if (s) setRuns(prev => [...prev.filter(r => r.run_id !== s.run_id), { ...s, target: t.target_id }]);
        }).catch(() => {});
      });
    });
  }, []);

  const online = targets.filter(t => t.state !== "offline").length;
  const active = targets.filter(t => t.state === "busy").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Header title={t("app.title")} sub={`${online} ${t("dash.online")} · ${active} ${t("dash.running")}`}>
        <Btn onClick={onStart}>{`+ ${t("nav.start")}`}</Btn>
      </Header>
      <Stats>
        <StatCard value={online} label={t("dash.online")} delta={t("dash.total", { n: targets.length })} />
        <StatCard value={active} label={t("dash.running")} delta={active > 0 ? t("dash.active", { n: active }) : "—"} tone={active > 0 ? "amber" : ""} />
        <StatCard value={runs.filter(r => r.state === "completed").length} label={t("dash.passed")} delta="" />
        <StatCard value={runs.filter(r => r.state === "failed").length} label={t("dash.failed")} delta="" tone="red" />
      </Stats>
      <Section>{t("dash.devices")}</Section>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 1, background: "var(--border)", borderRadius: 6, overflow: "hidden" }}>
        {targets.map(t => <DeviceCard key={t.target_id} target={t} onClick={() => t.current_run_id && onViewRun(t.current_run_id)} />)}
      </div>
      <Section>{t("dash.recentRuns")}</Section>
      <RunTable runs={runs} onClick={onViewRun} empty={t("dash.noRuns")} />
    </div>
  );
}

function DeviceCard({ target: dev, onClick }: { target: Target; onClick: () => void }) {
  const { t } = useT();
  const sc = dev.state === "busy" ? "var(--amber)" : dev.state === "offline" ? "var(--fg-tertiary)" : "var(--green)";
  const sb = dev.state === "busy" ? "#fdf6e8" : dev.state === "offline" ? "var(--bg-hover)" : "#eef5f0";
  return (
    <div onClick={onClick} style={{ background: "var(--bg-card)", padding: "18px 20px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "inline-block", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px", padding: "2px 8px", borderRadius: 3, color: sc, background: sb, alignSelf: "flex-start" }}>{dev.state}</span>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{dev.target_id}</div>
      <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10 }}>
        <Conn label={t("conn.serial")} on={dev.serial === "connected"} />
        <Conn label={t("conn.adb")} on={dev.adb === "online"} />
        <Conn label={t("conn.fastboot")} on={dev.fastboot === "connected"} />
      </div>
      {dev.current_run_id && <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--fg-secondary)" }}>▶ {dev.current_run_id}</div>}
    </div>
  );
}

function Conn({ label, on }: { label: string; on: boolean }) {
  return <span style={{ padding: "2px 7px", borderRadius: 3, color: on ? "var(--green)" : "var(--fg-tertiary)", background: on ? "#eef5f0" : "var(--bg-hover)" }}>{label}</span>;
}

function RunTable({ runs, onClick, empty }: { runs: any[]; onClick: (id: string) => void; empty: string }) {
  const { t } = useT();
  if (runs.length === 0) return <div style={{ color: "var(--fg-tertiary)", fontSize: 13, padding: 20 }}>{empty}</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{["run.table.run","run.table.target","run.table.state","run.table.time","run.table.summary"].map(h => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: "var(--fg-tertiary)", fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: ".5px", borderBottom: "1px solid var(--border)" }}>{t(h)}</th>)}</tr></thead>
      <tbody>
        {runs.map(r => {
          const v = r.state === "completed" ? "pass" : r.state === "failed" ? "fail" : "running";
          return (
            <tr key={r.run_id} onClick={() => onClick(r.run_id)} style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "10px 14px", fontSize: 13, fontFamily: "var(--font-mono)" }}>{r.run_id}</td>
              <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.target}</td>
              <td style={{ padding: "10px 14px" }}><Badge tone={v}>{t(`badge.${v}`)}</Badge></td>
              <td style={{ padding: "10px 14px", fontSize: 13, fontFamily: "var(--font-mono)" }}>{r.elapsed_sec ?? 0}s</td>
              <td style={{ padding: "10px 14px", fontSize: 13, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-secondary)" }}>{r.summary ?? r.state}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Badge({ tone, children }: { tone: string; children: string }) {
  const color = tone === "pass" ? "var(--green)" : tone === "fail" ? "var(--red)" : "var(--amber)";
  const bg = tone === "pass" ? "#eef5f0" : tone === "fail" ? "#fdf0ef" : "#fdf6e8";
  return <span style={{ display: "inline-block", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px", padding: "2px 8px", borderRadius: 3, color, background: bg }}>{children}</span>;
}

export function Header({ title, sub, children }: { title: string; sub?: string; children?: any }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}><div><h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.5px", margin: 0 }}>{title}</h1>{sub && <div style={{ color: "var(--fg-secondary)", fontSize: 13, marginTop: 2, fontFamily: "var(--font-mono)" }}>{sub}</div>}</div>{children}</div>;
}

export function Section({ children }: { children: string }) {
  return <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--fg-tertiary)", fontWeight: 500 }}>{children}</div>;
}

function Stats({ children }: { children: any }) {
  return <div style={{ display: "flex", gap: 1, background: "var(--border)", borderRadius: 6, overflow: "hidden" }}>{children}</div>;
}

function StatCard({ value, label, delta, tone }: { value: number; label: string; delta: string; tone?: string }) {
  return (
    <div style={{ background: "var(--bg-card)", padding: "16px 22px", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--font-mono)", letterSpacing: "-1px" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--fg-tertiary)", textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>
      {delta && <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: tone === "red" ? "var(--red)" : tone === "amber" ? "var(--amber)" : "var(--green)" }}>{delta}</div>}
    </div>
  );
}

export function Btn({ onClick, children, ghost }: { onClick: () => void; children: any; ghost?: boolean }) {
  return (
    <button onClick={onClick} style={{ background: ghost ? "transparent" : "var(--fg)", color: ghost ? "var(--fg)" : "var(--bg-card)", border: ghost ? "1px solid var(--border)" : "none", padding: "10px 24px", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, cursor: "pointer", letterSpacing: "-0.2px", transition: "opacity .12s" }}>
      {children}
    </button>
  );
}
