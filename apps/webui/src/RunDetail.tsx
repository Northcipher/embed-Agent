import { useState, useEffect, useRef } from "react";
import { api, type RunStatus, type RunEvent, type RunResult } from "./api";
import { Header, Btn, Section } from "./Dashboard";
import { useT } from "./i18n";

export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t } = useT();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    async function poll() {
      const s = await api.status(runId).catch(() => null);
      setStatus(s);
      if (!s) return;
      setPaused(s.state === "paused");
      const ev = await api.events(runId, events.length > 0 ? events[events.length - 1]!.seq : 0, 200).catch(() => null);
      if (ev?.events.length) setEvents(prev => [...prev, ...ev.events].slice(-500));
      if (["completed", "failed", "cancelled"].includes(s.state) && !result) {
        const r = await api.result(runId).catch(() => null);
        if (r) setResult(r);
      }
      if (s.current_step?.id) {
        try {
          const ev2 = await api.evidence(runId, `step-${s.current_step.id}:full`);
          if (ev2.available && ev2.content) setLog(ev2.content.split("\n").filter(Boolean).slice(-20));
        } catch {}
      }
    }
    poll();
    timer.current = setInterval(poll, 2000);
    return () => clearInterval(timer.current);
  }, [runId]);

  if (!status) return <div style={{ padding: 40, color: "var(--fg-tertiary)" }}>{t("detail.loading")}</div>;

  const terminal = ["completed", "failed", "cancelled"].includes(status.state);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Header title={runId} sub={`${status.state} · ${status.elapsed_sec}s`}>
        <div style={{ display: "flex", gap: 8 }}>
          {!terminal && <Btn ghost onClick={() => api.intervene(runId, paused ? "resume" : "pause").then(() => setPaused(!paused))}>{paused ? t("detail.resume") : t("detail.pause")}</Btn>}
          {!terminal && <Btn ghost onClick={() => api.intervene(runId, "cancel", "manual").then(() => setStatus(s => s ? { ...s, state: "cancelled" } : null))}>{t("detail.cancel")}</Btn>}
          <Btn ghost onClick={onBack}>← {t("detail.back")}</Btn>
        </div>
      </Header>
      <Section>{t("detail.timeline")}</Section>
      <Timeline events={events} />
      {events.filter(e => e.type === "decision_made").length > 0 && <>
        <Section>{t("detail.observer")}</Section>
        {events.filter(e => e.type === "decision_made").slice(-5).map((e, i) => {
          const p = e.payload ?? {};
          return (
            <div key={i} style={{ padding: "14px 18px", borderRadius: 6, background: "var(--bg-card)", border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>[{p.decision as string ?? "?"}] {e.step_id ?? ""}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-tertiary)" }}>conf {String(p.confidence ?? "?")}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5 }}>{e.summary}</div>
            </div>
          );
        })}
      </>}
      {log.length > 0 && <>
        <Section>{t("detail.serialOutput")}</Section>
        <pre style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: "16px 20px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.7, maxHeight: 240, overflow: "auto", color: "var(--fg-secondary)", margin: 0 }}>
          {log.map((l, i) => <div key={i} style={{ color: /warn|error|fail/i.test(l) ? "var(--amber)" : /panic|fatal/i.test(l) ? "var(--red)" : "inherit" }}>{l}</div>)}
        </pre>
      </>}
      {result?.criteria_results && result.criteria_results.length > 0 && <>
        <Section>{t("detail.criteria")}</Section>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {result.criteria_results.map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 14px", background: "var(--bg-card)", borderRadius: 6, border: "1px solid var(--border)", borderLeft: `3px solid ${c.status === "pass" ? "var(--green)" : c.status === "fail" ? "var(--red)" : "var(--amber)"}` }}>
              <span style={{ fontSize: 14, fontFamily: "var(--font-mono)", width: 20, textAlign: "center", color: c.status === "pass" ? "var(--green)" : c.status === "fail" ? "var(--red)" : "var(--fg-tertiary)" }}>{c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "—"}</span>
              <span>{c.criterion}</span>
            </div>
          ))}
        </div>
      </>}
      {result?.key_evidence && result.key_evidence.length > 0 && <>
        <Section>{t("detail.keyEvidence")}</Section>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {result.key_evidence.map((ke, i) => (
            <div key={i} style={{ fontSize: 12, padding: "10px 14px", background: "var(--bg-card)", borderRadius: 6, border: "1px solid var(--border)", color: "var(--fg-secondary)" }}>
              • {ke.summary} <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>[{(ke.evidence_refs ?? []).join(", ")}]</span>
            </div>
          ))}
        </div>
      </>}
      <details style={{ fontSize: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--fg-tertiary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>{t("detail.allEvents")} ({events.length})</summary>
        <div style={{ marginTop: 8, maxHeight: 300, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {events.map((e, i) => (
            <div key={i} style={{ padding: "3px 0", color: e.severity === "fatal" ? "var(--red)" : e.severity === "warning" ? "var(--amber)" : "var(--fg-tertiary)" }}>
              [{e.seq}] {e.type}: {e.summary?.slice(0, 120)}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Timeline({ events }: { events: RunEvent[] }) {
  const { t } = useT();
  const steps = new Map<string, { id: string; status: string }>();
  for (const e of events) {
    if (e.type === "step_started" && e.step_id) steps.set(e.step_id, { id: e.step_id, status: "running" });
    if (e.type === "step_completed" && e.step_id) { const s = steps.get(e.step_id); if (s) s.status = "done"; }
    if (e.type === "step_failed" && e.step_id) { const s = steps.get(e.step_id); if (s) s.status = "fail"; }
  }
  const items = [...steps.values()];
  if (items.length === 0) {
    const plan = events.find(e => e.type === "plan_generated");
    if (plan?.payload) {
      const stepCount = (plan.payload as any).step_count ?? 0;
      for (let i = 0; i < stepCount; i++) items.push({ id: `step-${i + 1}`, status: "pending" });
    }
  }

  return (
    <div style={{ position: "relative", paddingLeft: 22 }}>
      <div style={{ position: "absolute", left: 6, top: 6, bottom: 6, width: 1, background: "var(--border)" }} />
      {items.length === 0 ? <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>{t("detail.noSteps")}</div> : items.map((s, i) => {
        const color = s.status === "done" ? "var(--green)" : s.status === "fail" ? "var(--red)" : s.status === "running" ? "var(--blue)" : "var(--border)";
        const icon = s.status === "done" ? "✓" : s.status === "fail" ? "✗" : s.status === "running" ? "●" : "—";
        return (
          <div key={i} style={{ position: "relative", padding: "7px 0", fontSize: 13, display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ position: "absolute", left: -18, top: 13, width: 8, height: 8, borderRadius: "50%", background: s.status === "running" ? "var(--blue)" : s.status === "pending" ? "var(--bg-card)" : color, border: `2px solid ${color}`, animation: s.status === "running" ? "pulse 1.5s infinite" : "none" }} />
            <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", width: 18, textAlign: "center", color }}>{icon}</span>
            <span>{s.id}</span>
          </div>
        );
      })}
    </div>
  );
}
