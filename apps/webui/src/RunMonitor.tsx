import { useState, useEffect, useRef, useCallback, type Dispatch, type SetStateAction, type CSSProperties } from "react";
import { api, streamEvents, type RunStatus, type RunEvent } from "./api";
import { useT } from "./i18n";
import { PageHeader, StatusBadge, SectionHeader, ConfidenceBar, StepIcon } from "./shared";
import { displayElapsedSec, isTerminalRunState, parseIsoTimeMs } from "./time";

interface StepState {
  id: string; status: "pending" | "running" | "done" | "fail"; elapsed?: number; startedAtMs?: number;
}

export function RunMonitor({ runId, onBack, onCompleted }: {
  runId: string; onBack: () => void; onCompleted: () => void;
}) {
  const { t, fmtTime } = useT();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const [log, setLog] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<RunEvent[]>([]);
  const [signals, setSignals] = useState<RunEvent[]>([]);
  const [evidenceRef, setEvidenceRef] = useState<string | null>(null);
  const [evidenceContent, setEvidenceContent] = useState("");
  const [connectionLost, setConnectionLost] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEnd = useRef<HTMLDivElement>(null);
  const logContainer = useRef<HTMLDivElement>(null);
  const streamCtrl = useRef<AbortController | null>(null);
  const lastSeqRef = useRef(0);
  const seenSeqRef = useRef<Set<number>>(new Set());
  const completionScheduledRef = useRef(false);

  function applyIfNew(event: RunEvent): boolean {
    if (seenSeqRef.current.has(event.seq)) return false;
    seenSeqRef.current.add(event.seq);
    if (seenSeqRef.current.size > 1200) {
      const recentSeqs = [...seenSeqRef.current].sort((a, b) => a - b).slice(-900);
      seenSeqRef.current = new Set(recentSeqs);
    }
    lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
    if (event.type === "run_started") rememberRunStart(event.time);
    applyMonitorEvent(event, runId, setSteps, setDecisions, setSignals, setLog);
    return true;
  }

  function rememberRunStart(value: string | undefined): void {
    const parsed = parseIsoTimeMs(value);
    if (parsed !== null) setRunStartedAtMs(parsed);
  }

  function scheduleCompleted(delayMs: number): void {
    if (completionScheduledRef.current) return;
    completionScheduledRef.current = true;
    window.setTimeout(onCompleted, delayMs);
  }

  // Initial load: status + existing events
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const s = await api.status(runId).catch(() => null);
      if (cancelled) return;
      setStatus(s);
      rememberRunStart(s?.started_at);
      if (!s) return;

      // Load existing events for context
      const ev = await api.events(runId, 0, 200).catch(() => null);
      if (cancelled) return;

      for (const e of ev?.events ?? []) {
        applyIfNew(e);
      }

      // Check if already terminal
      if (["completed", "failed", "cancelled"].includes(s.state)) {
        scheduleCompleted(800);
        return;
      }
    }
    init();
    return () => { cancelled = true; };
  }, [runId]);

  // SSE stream for live updates
  useEffect(() => {
    let cancelled = false;
    const ctrl = streamEvents(
      runId,
      (event) => {
        if (cancelled) return;
        setConnectionLost(false);
        if (!applyIfNew(event)) return;

        switch (event.type) {
          case "run_completed":
          case "run_failed":
          case "run_cancelled":
            setStatus(s => s ? { ...s, state: event.type.replace("run_", ""), ended_at: s.ended_at ?? event.time } : null);
            break;
          case "result_ready":
            // Result is now readable — safe to navigate
            scheduleCompleted(500);
            break;
        }
      },
      (err) => {
        if (!cancelled) setConnectionLost(true);
        console.warn("SSE error:", err);
      },
    );
    streamCtrl.current = ctrl;

    // Poll status as fallback
    const pollTimer = setInterval(async () => {
      if (cancelled) return;
      try {
        const [s, ev] = await Promise.all([
          api.status(runId),
          api.events(runId, lastSeqRef.current, 100),
        ]);
        if (s) {
          setStatus(s);
          rememberRunStart(s.started_at);
        }
        if (s && ["completed", "failed", "cancelled"].includes(s.state)) {
          scheduleCompleted(500);
        }
        for (const event of ev.events) {
          if (!applyIfNew(event)) continue;
          if (event.type === "result_ready") scheduleCompleted(500);
        }
      } catch { /* ok */ }
    }, 2000);

    return () => {
      cancelled = true;
      ctrl.abort();
      streamCtrl.current = null;
      clearInterval(pollTimer);
    };
  }, [runId]);

  useEffect(() => {
    if (!status || isTerminalRunState(status.state)) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.state]);

  // Auto-scroll log
  useEffect(() => {
    if (autoScroll && logContainer.current) {
      logContainer.current.scrollTop = logContainer.current.scrollHeight;
    }
  }, [log, autoScroll]);

  // Detect manual scroll up
  const handleLogScroll = useCallback(() => {
    const el = logContainer.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  }, []);

  async function openEvidence(ref: string): Promise<void> {
    setEvidenceRef(ref);
    setEvidenceContent(t("monitor.loadingEvidence"));
    try {
      const e = await api.evidence(runId, ref);
      setEvidenceContent(e.content ?? (e.available ? t("monitor.evidenceNoContent") : t("monitor.evidenceUnavailable")));
    } catch (e) {
      setEvidenceContent("Error: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!status) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <PageHeader title={runId} onBack={onBack} />
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="skeleton" style={{ width: "100%", height: 120 }} />
          <div className="skeleton" style={{ width: "100%", height: 200 }} />
        </div>
      </div>
    );
  }

  const isTerminal = ["completed", "failed", "cancelled"].includes(status.state);
  const tone = status.state === "completed" ? "pass" : status.state === "failed" ? "fail" : status.state === "cancelled" ? "cancelled" : "running";
  const displayElapsed = displayElapsedSec(status, nowMs, runStartedAtMs);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn .2s ease both" }}>
      {/* Header */}
      <PageHeader
        title={`${runId} · ${formatRunState(status.state, t)}`}
        subtitle={fmtTime(displayElapsed)}
        onBack={onBack}
      >
        {!isTerminal && (
          <>
            <button onClick={() => {
                const action = status.state === "paused" ? "resume" : "pause";
                api.intervene(runId, action).then(() => setStatus(s => s ? { ...s, state: action === "pause" ? "paused" : "running" } : null));
              }}
              style={controlBtnStyle}>
              {status.state === "paused" ? "▶" : "⏸"}
            </button>
            <button onClick={() => {
              if (confirm(t("monitor.cancelConfirm"))) {
                api.intervene(runId, "cancel", "manual").then(() => setStatus(s => s ? { ...s, state: "cancelled" } : null));
              }
            }} style={{ ...controlBtnStyle, color: "var(--red)", borderColor: "var(--red)" }}>
              ⏹
            </button>
          </>
        )}
        {isTerminal && <StatusBadge tone={tone}>{t(`badge.${tone}`)}</StatusBadge>}
      </PageHeader>

      {connectionLost && (
        <div style={{
          padding: "8px 14px", borderRadius: 4, background: "#fdf4e4", border: "1px solid var(--amber)",
          fontSize: 12, color: "var(--amber)", fontFamily: "var(--font-mono)",
        }}>
          {t("monitor.connectionLost")}
        </div>
      )}

      {/* Three-column area: Steps + Serial + Signals */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, .8fr) minmax(320px, 1.2fr) minmax(280px, .9fr)", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden", height: "clamp(360px, calc(100vh - 260px), 560px)", minHeight: 360 }}>
        {/* Step Progress */}
        <div style={{ background: "var(--bg-card)", padding: "16px 20px", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <SectionHeader>{t("monitor.stepProgress")}</SectionHeader>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2, overflow: "auto", minHeight: 0 }}>
            {steps.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--fg-tertiary)", padding: "8px 0" }}>{t("monitor.noSteps")}</div>
            ) : (
              steps.map((s, i) => {
                const stepElapsed = s.elapsed ?? (s.status === "running" && s.startedAtMs ? Math.max(0, Math.floor((nowMs - s.startedAtMs) / 1000)) : undefined);
                return (
                  <div key={s.id} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "7px 0",
                    fontSize: 12, borderBottom: i < steps.length - 1 ? "1px solid var(--border-light)" : "none",
                  }}>
                    <StepIcon status={s.status} />
                    <span style={{
                      fontFamily: "var(--font-mono)", fontWeight: s.status === "running" ? 600 : 400,
                      color: s.status === "running" ? "var(--fg)" : s.status === "fail" ? "var(--red)" : "var(--fg-secondary)",
                      flex: 1,
                    }}>{s.id}</span>
                    {stepElapsed != null && (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>
                        {fmtTime(stepElapsed)}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 20, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)", flexShrink: 0 }}>
            <span>{t("monitor.elapsed")}: {fmtTime(displayElapsed)}</span>
          </div>
        </div>

        {/* Serial Terminal */}
        <div style={{ background: "var(--bg-terminal)", display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div style={{ padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.08)", flexShrink: 0 }}>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "rgba(255,255,255,.4)", fontWeight: 600 }}>
              {t("monitor.serialOutput")}
            </span>
            {!autoScroll && (
              <button onClick={() => { setAutoScroll(true); if (logContainer.current) logContainer.current.scrollTop = logContainer.current.scrollHeight; }}
                style={{
                  background: "rgba(255,255,255,.08)", border: "none", color: "rgba(255,255,255,.6)",
                  padding: "2px 10px", borderRadius: 3, cursor: "pointer", fontSize: 10,
                  fontFamily: "var(--font-mono)",
                }}
              >↓ {t("monitor.follow")}</button>
            )}
          </div>
          <div ref={logContainer} onScroll={handleLogScroll} style={{
            flex: 1, minHeight: 0, overflow: "auto", padding: "10px 14px",
            fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.7,
            color: "rgba(255,255,255,.75)", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          }}>
            {log.length === 0 ? (
              <div style={{ color: "rgba(255,255,255,.25)" }}>{t("monitor.noSerial")}</div>
            ) : (
              log.map((l, i) => (
                <div key={i} style={{
                  color: /warn|error|fail/i.test(l) ? "#e8a840" : /panic|fatal|critical/i.test(l) ? "#e0554a" : /\[.*\]/.test(l) ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.75)",
                }}>{l}</div>
              ))
            )}
            <div ref={logEnd} />
          </div>
        </div>

        {/* Signal Timeline */}
        <div style={{ background: "var(--bg-card)", padding: "16px 18px", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <SectionHeader>{t("monitor.signalTimeline")}</SectionHeader>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 1, overflow: "auto", minHeight: 0 }}>
            {signals.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--fg-tertiary)", padding: "8px 0" }}>{t("monitor.noSignals")}</div>
            ) : signals.slice().reverse().map(e => (
              <SignalRow key={e.seq} event={e} onEvidence={openEvidence} />
            ))}
          </div>
        </div>
      </div>

      {/* Observer Decisions */}
      {decisions.length > 0 && (
        <>
          <SectionHeader>{t("monitor.observerDecisions")}</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
            {decisions.slice().reverse().map((e, i) => {
              const p = e.payload ?? {};
              const decision = (p.decision as string) ?? "unknown";
              const confidence = (p.confidence as number) ?? 0;
              const reason = (p.reason as string) ?? e.summary ?? "";
              const isLatest = i === 0;
              return (
                <div key={e.seq} style={{
                  background: "var(--bg-card)", padding: isLatest ? "14px 20px" : "10px 20px",
                  transition: "all .2s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isLatest ? 4 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{
                        fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600,
                        color: decision === "stop" ? "var(--red)" : decision === "continue" ? "var(--green)" : "var(--blue)",
                        textTransform: "uppercase",
                      }}>{formatDecision(decision, t)}</span>
                      {e.step_id && <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-tertiary)" }}>{e.step_id}</span>}
                      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-tertiary)" }}>#{e.seq}</span>
                    </div>
                    <ConfidenceBar value={confidence} />
                  </div>
                  {isLatest && <div style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5, marginTop: 4 }}>{reason}</div>}
                  {isLatest && <EvidenceRefs refs={e.evidence_refs ?? (Array.isArray(p.evidence_refs) ? p.evidence_refs as string[] : [])} onEvidence={openEvidence} />}
                </div>
              );
            })}
          </div>
        </>
      )}

      {evidenceRef && (
        <EvidenceDrawer refName={evidenceRef} content={evidenceContent} onClose={() => setEvidenceRef(null)} />
      )}
    </div>
  );
}

function isSignalEvent(e: RunEvent): boolean {
  return ["rule_matched", "checkpoint", "correlated", "baseline_diff", "target_state_changed", "decision_made", "decision_rejected", "rule_ignored"].includes(e.type);
}

function applyMonitorEvent(
  event: RunEvent,
  runId: string,
  setSteps: Dispatch<SetStateAction<StepState[]>>,
  setDecisions: Dispatch<SetStateAction<RunEvent[]>>,
  setSignals: Dispatch<SetStateAction<RunEvent[]>>,
  setLog: Dispatch<SetStateAction<string[]>>,
): void {
  switch (event.type) {
    case "step_started": {
      const sid = event.step_id;
      if (!sid) return;
      const startedAtMs = parseIsoTimeMs(event.time) ?? undefined;
      setSteps(prev => {
        const exists = prev.some(step => step.id === sid);
        if (exists) return prev.map(step => step.id === sid ? { ...step, status: "running", ...(startedAtMs !== undefined ? { startedAtMs } : {}) } : step);
        return [...prev, { id: sid, status: "running", ...(startedAtMs !== undefined ? { startedAtMs } : {}) }];
      });
      return;
    }
    case "step_completed":
      setSteps(prev => prev.map(step => {
        if (step.id !== event.step_id) return step;
        const elapsed = numberFromPayload(event.payload, "elapsed_sec") ?? elapsedFromStepTimes(step.startedAtMs, event.time);
        return elapsed === undefined ? { ...step, status: "done" } : { ...step, status: "done", elapsed };
      }));
      return;
    case "step_failed":
      setSteps(prev => prev.map(step => step.id === event.step_id ? { ...step, status: "fail" } : step));
      return;
    case "decision_made":
      setDecisions(prev => [...prev, event].slice(-20));
      setSignals(prev => [...prev, event].slice(-40));
      return;
    case "rule_matched":
    case "checkpoint":
    case "correlated":
    case "baseline_diff":
    case "target_state_changed":
    case "decision_rejected":
    case "rule_ignored":
      setSignals(prev => [...prev, event].slice(-40));
      return;
    case "signal_received":
    case "serial_output": {
      const payloadContent = stringFromPayload(event.payload, "content");
      const content = payloadContent ?? event.summary;
      setLog(prev => [...prev, ...content.split("\n").filter(line => line.trim())].slice(-500));
      return;
    }
    case "plan_generated": {
      const count = numberFromPayload(event.payload, "step_count") ?? 0;
      if (count > 0) {
        setSteps(prev => prev.length > 0
          ? prev
          : Array.from({ length: count }, (_, i) => ({ id: `${i + 1}`, status: "pending" as const })));
      }
      return;
    }
    case "observation": {
      const stepId = stringFromPayload(event.payload, "step_id") ?? event.step_id;
      if (!stepId) return;
      void api.evidence(runId, `step-${stepId}:full`).then(evidence => {
        if (evidence.available && evidence.content) {
          setLog(evidence.content.split("\n").filter(line => line.trim()).slice(-500));
        }
      }).catch(() => {});
      return;
    }
    default:
      return;
  }
}

function stringFromPayload(payload: RunEvent["payload"], key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberFromPayload(payload: RunEvent["payload"], key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" ? value : undefined;
}

function elapsedFromStepTimes(startedAtMs: number | undefined, endTime: string): number | undefined {
  const endedAtMs = parseIsoTimeMs(endTime);
  if (startedAtMs === undefined || endedAtMs === null) return undefined;
  return Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
}

function SignalRow({ event, onEvidence }: { event: RunEvent; onEvidence: (ref: string) => void }) {
  const { t } = useT();
  const color = event.severity === "fatal" ? "var(--red)" : event.severity === "warning" ? "var(--amber)" : event.type === "decision_made" ? "var(--blue)" : "var(--fg-tertiary)";
  return (
    <div style={{ borderBottom: "1px solid var(--border-light)", padding: "8px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
        <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 24 }}>#{event.seq}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color }}>{formatEventType(event.type, t)}</span>
        {event.step_id && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)", marginLeft: "auto" }}>{event.step_id}</span>}
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-secondary)", lineHeight: 1.4 }}>{event.summary}</div>
      <EvidenceRefs refs={event.evidence_refs ?? []} onEvidence={onEvidence} />
    </div>
  );
}

function formatEventType(type: string, t: (key: string) => string): string {
  const label = t(`event.${type}`);
  return label.startsWith("event.") ? type.replaceAll("_", " ") : label;
}

function formatDecision(value: string, t: (key: string) => string): string {
  const label = t(`decision.${value}`);
  return label.startsWith("decision.") ? value.replaceAll("_", " ") : label;
}

function formatRunState(state: string, t: (key: string) => string): string {
  const translated = t(`run.state.${state}`);
  return translated.startsWith("run.state.") ? state.replaceAll("_", " ") : translated;
}

function EvidenceRefs({ refs, onEvidence }: { refs: string[]; onEvidence: (ref: string) => void }) {
  if (refs.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
      {refs.map(ref => (
        <button key={ref} type="button" onClick={() => onEvidence(ref)} style={{
          border: "1px solid var(--border)", background: "var(--bg-inset)", borderRadius: 3,
          padding: "2px 6px", fontSize: 10, fontFamily: "var(--font-mono)",
          color: "var(--fg-secondary)", cursor: "pointer",
        }}>{ref}</button>
      ))}
    </div>
  );
}

function EvidenceDrawer({ refName, content, onClose }: { refName: string; content: string; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", right: 24, bottom: 24, width: "min(720px, calc(100vw - 80px))", maxHeight: "70vh", zIndex: 20, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, boxShadow: "0 16px 40px rgba(0,0,0,.12)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-secondary)" }}>{refName}</span>
        <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", color: "var(--fg-tertiary)", cursor: "pointer", fontSize: 16 }}>×</button>
      </div>
      <pre style={{ margin: 0, padding: "12px 14px", overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6, color: "var(--fg-secondary)", whiteSpace: "pre-wrap" }}>{content}</pre>
    </div>
  );
}

const controlBtnStyle: CSSProperties = {
  width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
  background: "transparent", border: "1px solid var(--border)", borderRadius: 4,
  color: "var(--fg-secondary)", fontSize: 14, cursor: "pointer",
  fontFamily: "var(--font-mono)", transition: "all .12s",
};
