import { useState, useCallback, useEffect } from "react";
import { api, type Target, type RunSummary } from "./api";
import { useT } from "./i18n";
import { PageHeader, StatusBadge, SectionHeader, EmptyState, Btn } from "./shared";
import { displayElapsedSec, isTerminalRunState } from "./time";

export function Dashboard({ onViewRun, onViewResult, onStart, onViewHistory }: {
  onViewRun: (id: string) => void;
  onViewResult: (id: string) => void;
  onStart: () => void;
  onViewHistory: () => void;
}) {
  const { t, fmtTime } = useT();
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const ts = await api.targets();
      setTargets(ts);

      // Gather active runs from targets
      const active: RunSummary[] = [];
      for (const t of ts) {
        if (!t.current_run_id) continue;
        try {
          const s = await api.status(t.current_run_id);
          if (!s) continue;
          const run: RunSummary = {
            run_id: s.run_id,
            target: t.target_id,
            state: s.state,
            elapsed_sec: s.elapsed_sec,
            summary: s.state,
          };
          if (s.created_at) run.created_at = s.created_at;
          if (s.started_at) run.started_at = s.started_at;
          if (s.ended_at) run.ended_at = s.ended_at;
          active.push(run);
        } catch { /* run may have ended */ }
      }
      setRuns(active);
    } catch { /* server may not be running */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!runs.some(run => !isTerminalRunState(run.state))) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runs]);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <PageHeader title={t("app.title")} />
        <DashboardSkeleton />
      </div>
    );
  }

  const online = targets.filter(t => t.state !== "offline").length;
  const active = targets.filter(t => t.state === "busy").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, animation: "fadeIn .2s ease both" }}>
      <PageHeader title={t("app.title")} subtitle={`${online} ${t("dash.online")} · ${active} ${t("dash.busy")}`}>
        <Btn onClick={onStart}>+ {t("nav.newRun")}</Btn>
      </PageHeader>

      {/* Device Grid */}
      <SectionHeader>{t("nav.dashboard")}</SectionHeader>
      {targets.length === 0 ? (
        <EmptyState icon="○" title={t("dash.noDevices")} hint={t("dash.deviceHint")} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {targets.map(t => (
            <DeviceCard
              key={t.target_id}
              target={t}
              onClick={() => t.current_run_id ? onViewRun(t.current_run_id) : null}
            />
          ))}
        </div>
      )}

      {/* Active Runs */}
      <SectionHeader {...(runs.length > 0 ? { onViewAll: onViewHistory } : {})}>{t("dash.activeRuns")}</SectionHeader>
      {runs.length === 0 ? (
        <EmptyState icon="▶" title={t("dash.noActiveRuns")} hint={t("dash.runHint")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {runs.map(r => (
            <RunRow key={r.run_id} run={r} onClick={() => {
              if (["completed", "failed", "cancelled"].includes(r.state)) onViewResult(r.run_id);
              else onViewRun(r.run_id);
            }} fmtTime={fmtTime} nowMs={nowMs} />
          ))}
        </div>
      )}

      {/* Recent Results (from targets) */}
      <SectionHeader onViewAll={onViewHistory}>{t("dash.recentResults")}</SectionHeader>
      <RecentResults onViewResult={onViewResult} fmtTime={fmtTime} />
    </div>
  );
}

/* ── DeviceCard ── */
function DeviceCard({ target: dev, onClick }: { target: Target; onClick: (() => void) | null }) {
  const stateLabel = dev.state === "busy" ? "badge.busy" : dev.state === "offline" ? "badge.offline" : "badge.online";
  const stateTone = dev.state === "busy" ? "busy" : dev.state === "offline" ? "offline" : "online";
  const { t } = useT();

  return (
    <div
      onClick={() => onClick?.()}
      style={{
        background: "var(--bg-card)", padding: "16px 20px",
        cursor: onClick ? "pointer" : "default",
        display: "flex", flexDirection: "column", gap: 6,
        transition: "background .1s",
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.background = "var(--bg-card)"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <StatusBadge tone={stateTone}>{t(stateLabel)}</StatusBadge>
        {dev.current_run_id && <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--blue)" }}>▶</span>}
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, fontFamily: "var(--font-mono)" }}>{dev.target_id}</div>
      <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10 }}>
        <Conn label={t("conn.serial")} on={dev.serial === "connected"} />
        <Conn label={t("conn.adb")} on={dev.adb === "online"} />
        <Conn label={t("conn.fastboot")} on={dev.fastboot === "connected"} />
      </div>
      {dev.current_run_id && (
        <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-secondary)", marginTop: 2 }}>
          {dev.current_run_id}
        </div>
      )}
    </div>
  );
}

function Conn({ label, on }: { label: string; on: boolean }) {
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 3, fontSize: 10,
      color: on ? "var(--green)" : "var(--fg-tertiary)",
      background: on ? "#e8f3e9" : "var(--bg-inset)",
      fontFamily: "var(--font-mono)",
    }}>{label}</span>
  );
}

/* ── RunRow ── */
function RunRow({ run, onClick, fmtTime, nowMs }: { run: RunSummary; onClick: () => void; fmtTime: (s: number) => string; nowMs: number }) {
  const { t } = useT();
  const tone = run.state === "completed" ? "pass" : run.state === "failed" ? "fail" : run.state === "cancelled" ? "cancelled" : "running";
  const elapsed = displayElapsedSec(run, nowMs);
  return (
    <div onClick={onClick} style={{
      background: "var(--bg-card)", padding: "12px 20px", cursor: "pointer",
      display: "flex", alignItems: "center", gap: 14, transition: "background .1s",
    }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "var(--bg-card)"; }}
    >
      <StatusBadge tone={tone}>{t(`badge.${tone}`)}</StatusBadge>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", minWidth: 80 }}>{run.run_id}</span>
      <span style={{ fontSize: 12, color: "var(--fg-tertiary)", minWidth: 70, fontFamily: "var(--font-mono)" }}>{run.target}</span>
      <span style={{ fontSize: 12, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>{fmtTime(elapsed)}</span>
    </div>
  );
}

/* ── RecentResults ── */
function RecentResults({ onViewResult, fmtTime }: { onViewResult: (id: string) => void; fmtTime: (s: number) => string }) {
  const { t } = useT();
  const [results, setResults] = useState<RunSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.targets().then(ts => {
      if (cancelled) return;
      const items: RunSummary[] = [];
      Promise.all(ts.map(t =>
        api.history(t.target_id, 5).then(h => {
          for (const item of h) {
            const run: RunSummary = {
              run_id: item.run_id,
              target: t.target_id,
              state: item.result ?? item.state ?? "unknown",
              elapsed_sec: item.elapsed_sec ?? 0,
              summary: item.summary ?? "",
            };
            if (item.created_at) run.created_at = item.created_at;
            if (item.started_at) run.started_at = item.started_at;
            if (item.ended_at) run.ended_at = item.ended_at;
            if (item.recorded_at) run.recorded_at = item.recorded_at;
            items.push(run);
          }
        }).catch(() => {})
      )).then(() => {
        if (!cancelled) {
          items.sort((a, b) => (b.recorded_at ?? b.ended_at ?? b.run_id).localeCompare(a.recorded_at ?? a.ended_at ?? a.run_id));
          setResults(items.slice(0, 5));
        }
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (results.length === 0) {
    return <EmptyState icon="—" title={t("dash.noResults")} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {results.map(r => {
        const tone = r.state === "completed" || r.state === "pass" ? "pass" : r.state === "failed" || r.state === "fail" ? "fail" : "running";
        const elapsed = displayElapsedSec(r, Date.now());
        return (
          <div key={r.run_id} onClick={() => onViewResult(r.run_id)} style={{
            background: "var(--bg-card)", padding: "10px 20px", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 14, transition: "background .1s",
          }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--bg-card)"; }}
          >
            <StatusBadge tone={tone}>{t(`badge.${tone}`)}</StatusBadge>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", minWidth: 80 }}>{r.run_id}</span>
            <span style={{ fontSize: 12, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", minWidth: 70 }}>{r.target}</span>
            <span style={{ fontSize: 12, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>{fmtTime(elapsed)}</span>
            <span style={{ fontSize: 11, color: "var(--fg-tertiary)", flex: 1, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.summary?.slice(0, 80) ?? ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── DashboardSkeleton ── */
function DashboardSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ background: "var(--bg-card)", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="skeleton" style={{ width: 48, height: 18 }} />
            <div className="skeleton" style={{ width: "70%", height: 14 }} />
            <div className="skeleton" style={{ width: "50%", height: 10 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {[1, 2].map(i => (
          <div key={i} style={{ background: "var(--bg-card)", padding: "12px 20px" }}>
            <div className="skeleton" style={{ width: "60%", height: 14 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
