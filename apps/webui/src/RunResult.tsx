import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RunResult as RR, type RunEvent } from "./api";
import { useT } from "./i18n";
import { PageHeader, StatusBadge, SectionHeader, StepIcon, EmptyState, ConfidenceBar } from "./shared";
import { displayElapsedSec } from "./time";

type InspectorTab = "evidence" | "process" | "events" | "debug";
type EvidenceRef = NonNullable<RR["evidence_index"]>[number];
type RunStep = NonNullable<RR["steps"]>[number];
type ProcessSummaryItem = NonNullable<RR["process_summary"]>[number];
type Tone = "pass" | "fail" | "cancelled" | "running";

export function RunResult({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t, fmtTime } = useT();
  const [result, setResult] = useState<RR | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState("");
  const [tab, setTab] = useState<InspectorTab>("evidence");
  const [rawEventsOpen, setRawEventsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const selectedRefRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRefRef.current = selectedRef;
  }, [selectedRef]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load(showLoading: boolean): Promise<RR | null> {
      if (showLoading) setLoading(true);
      else setRefreshing(true);
      try {
        const [r, ev] = await Promise.all([
          api.result(runId),
          api.events(runId, 0, 700),
        ]);
        if (cancelled) return null;
        setResult(r);
        setEvents(ev.events);
        setLastUpdatedAt(new Date().toLocaleTimeString());
        const firstRef = firstUsefulRef(r);
        if (!selectedRefRef.current && firstRef) {
          setSelectedRef(firstRef);
          void loadEvidence(firstRef);
        }
        return r;
      } catch {
        if (!cancelled && showLoading) setResult(null);
        return null;
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    async function loadEvidence(ref: string): Promise<void> {
      if (cancelled) return;
      setSelectedContent(t("monitor.loadingEvidence"));
      try {
        const evidence = await api.evidence(runId, ref);
        if (cancelled) return;
        setSelectedContent(evidence.content ?? (evidence.available ? t("monitor.evidenceNoContent") : t("monitor.evidenceUnavailable")));
      } catch (e) {
        if (!cancelled) setSelectedContent("Error: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    async function loop(): Promise<void> {
      const loaded = await load(false);
      if (cancelled) return;
      if (loaded && !isTerminalState(loaded.state)) {
        timer = window.setTimeout(loop, 2000);
      }
    }

    void load(true).then(loaded => {
      if (!cancelled && loaded && !isTerminalState(loaded.state)) {
        timer = window.setTimeout(loop, 2000);
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, t]);

  async function openEvidence(ref: string): Promise<void> {
    setTab("evidence");
    setSelectedRef(ref);
    setSelectedContent(t("monitor.loadingEvidence"));
    try {
      const e = await api.evidence(runId, ref);
      setSelectedContent(e.content ?? (e.available ? t("monitor.evidenceNoContent") : t("monitor.evidenceUnavailable")));
    } catch (error) {
      setSelectedContent("Error: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  const metrics = useMemo(() => result ? computeMetrics(result) : null, [result]);

  useEffect(() => {
    if (!result || isTerminalState(result.state)) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [result?.state]);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <PageHeader title={runId} onBack={onBack} />
        <div className="skeleton" style={{ width: "100%", height: 88 }} />
        <div className="skeleton" style={{ width: "100%", height: 360 }} />
      </div>
    );
  }

  if (!result) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <PageHeader title={runId} onBack={onBack} />
        <EmptyState icon="x" title={t("result.loadFailed")} />
      </div>
    );
  }

  const tone = resultTone(result.state);
  const elapsed = result.timing
    ? displayElapsedSec({
      state: result.state,
      elapsed_sec: result.timing.elapsed_sec,
      created_at: result.timing.created_at,
      ...(result.timing.started_at ? { started_at: result.timing.started_at } : {}),
      ...(result.timing.ended_at ? { ended_at: result.timing.ended_at } : {}),
    }, nowMs)
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "fadeIn .2s ease both" }}>
      <PageHeader
        title={`${t("result.title")} · ${shortRunId(runId)}`}
        subtitle={`${t("result.subtitleDevice")}: ${result.target_id ?? t("result.unknown")} / ${t("result.subtitleFileType")}: ${result.artifact?.type ?? t("result.unknown")}`}
        onBack={onBack}
      >
        {refreshing && <span style={microTagStyle}>{t("result.refreshing")}</span>}
        {lastUpdatedAt && <span style={microTagStyle}>{t("result.lastUpdated", { time: lastUpdatedAt })}</span>}
        <StatusBadge tone={tone}>{t(`badge.${tone}`)}</StatusBadge>
      </PageHeader>

      <VerdictStrip result={result} metrics={metrics} elapsed={elapsed} fmtTime={fmtTime} t={t} onEvidence={openEvidence} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(360px, .9fr)", gap: 18, alignItems: "start" }}>
        <main style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <VerdictPanel result={result} t={t} />
          <ProcessSummary result={result} t={t} onEvidence={openEvidence} />
          <CriteriaMatrix result={result} t={t} onEvidence={openEvidence} />
          <StepTimeline steps={result.steps ?? []} t={t} onEvidence={openEvidence} />
          <RelatedHistory result={result} t={t} />
          <RawEvents events={events} open={rawEventsOpen} setOpen={setRawEventsOpen} t={t} onEvidence={openEvidence} />
        </main>

        <aside style={{ position: "sticky", top: 18, minWidth: 0 }}>
          <EvidenceInspector
            result={result}
            events={events}
            selectedRef={selectedRef}
            selectedContent={selectedContent}
            tab={tab}
            setTab={setTab}
            t={t}
            onEvidence={openEvidence}
          />
        </aside>
      </div>
    </div>
  );
}

function VerdictStrip({ result, metrics, elapsed, fmtTime, t, onEvidence }: {
  result: RR; metrics: ReturnType<typeof computeMetrics> | null; elapsed: number; fmtTime: (sec: number) => string;
  t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  const runMode = result.source?.kind === "task" ? t("result.taskRun") : t("result.manualRun");
  const runModeDetail = result.source?.kind === "task" ? (result.source.task_name ?? result.task ?? "") : "";
  const artifact = result.artifact?.path ?? t("result.noArtifact");
  return (
    <section style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 0 }}>
        <MetricCell label={t("result.metricTarget")} value={result.target_id ?? t("result.unknown")} detail={formatTargetState(result.target_state, t)} />
        <MetricCell label={t("result.metricSource")} value={runMode} detail={runModeDetail} />
        <MetricCell label={t("result.metricArtifact")} value={basename(artifact)} detail={result.artifact?.build_id ?? result.artifact?.version ?? result.artifact?.type ?? ""} title={artifact} />
        <MetricCell label={t("result.metricCriteria")} value={`${metrics?.criteriaPass ?? 0}/${metrics?.criteriaTotal ?? 0}`} detail={t("result.criteriaPass")} tone={(metrics?.criteriaFail ?? 0) > 0 ? "bad" : "ok"} />
        <MetricCell label={t("result.metricEvidence")} value={`${metrics?.evidenceCount ?? 0}`} detail={(result.missing_evidence_refs?.length ?? 0) > 0 ? t("result.missingEvidenceShort", { n: result.missing_evidence_refs!.length }) : t("result.available")} tone={(result.missing_evidence_refs?.length ?? 0) > 0 ? "warn" : "muted"} />
        <MetricCell label={t("result.metricWarnings")} value={`${result.event_summary?.warnings ?? 0}/${result.event_summary?.fatals ?? 0}`} detail={t("result.warningFatal")} tone={(result.event_summary?.fatals ?? 0) > 0 ? "bad" : (result.event_summary?.warnings ?? 0) > 0 ? "warn" : "ok"} />
        <MetricCell label={t("result.metricElapsed")} value={elapsed > 0 ? fmtTime(elapsed) : t("result.unknown")} detail={timeRange(result)} />
      </div>
      {(result.missing_evidence_refs?.length ?? 0) > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 11, color: "var(--amber)" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{t("result.evidenceMismatch")}</span>
          <EvidenceRefs refs={result.missing_evidence_refs ?? []} knownRefs={result.evidence_index ?? []} onEvidence={onEvidence} missingTitle={t("result.missingEvidenceTitle")} compact />
        </div>
      )}
    </section>
  );
}

function VerdictPanel({ result, t }: { result: RR; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <section style={panelStyle}>
      <SectionHeader>{t("result.verdict")}</SectionHeader>
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 160px", gap: 18 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>{result.summary ?? t("result.noSummary")}</p>
          {result.failure_signature && (
            <div style={{ marginTop: 12, borderLeft: "3px solid var(--red)", paddingLeft: 10, color: "var(--fg-secondary)", fontSize: 12, lineHeight: 1.5 }}>
              <span style={labelStyle}>{t("result.failureSignature")}</span>
              <div>{result.failure_signature}</div>
            </div>
          )}
          {result.suggested_next && (
            <div style={{ marginTop: 12, borderLeft: "3px solid var(--blue)", paddingLeft: 10, color: "var(--fg-secondary)", fontSize: 12, lineHeight: 1.5 }}>
              <span style={labelStyle}>{t("result.suggestedNext")}</span>
              <div>{result.suggested_next}</div>
            </div>
          )}
        </div>
        <div style={{ border: "1px solid var(--border-light)", background: "var(--bg-inset)", borderRadius: 4, padding: 12 }}>
          <div style={labelStyle}>{t("result.confidence")}</div>
          {typeof result.confidence === "number" ? <ConfidenceBar value={result.confidence} /> : <div style={mutedStyle}>{t("result.unknown")}</div>}
          <div style={{ ...labelStyle, marginTop: 14 }}>{t("result.expected")}</div>
          <div style={{ ...mutedStyle, lineHeight: 1.4 }}>{result.expected ?? t("result.unknown")}</div>
        </div>
      </div>
    </section>
  );
}

function CriteriaMatrix({ result, t, onEvidence }: {
  result: RR; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  const criteria = [...(result.criteria_results ?? [])].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  return (
    <section style={panelStyle}>
      <SectionHeader>{t("result.criteria")}</SectionHeader>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {criteria.length === 0 ? (
          <div style={{ padding: 14, color: "var(--fg-tertiary)", fontSize: 12 }}>{t("result.noCriteria")}</div>
        ) : criteria.map((criterion, index) => {
          const status = criterion.status === "pass" ? "done" : criterion.status === "fail" ? "fail" : "pending";
          return (
            <div key={`${criterion.criterion}-${index}`} style={{ display: "grid", gridTemplateColumns: "26px minmax(0, 1fr) minmax(180px, auto)", gap: 10, alignItems: "center", padding: "10px 12px", background: "var(--bg-card)", borderBottom: index === criteria.length - 1 ? "none" : "1px solid var(--border-light)", borderLeft: `3px solid ${criterion.status === "pass" ? "var(--green)" : criterion.status === "fail" ? "var(--red)" : "var(--amber)"}` }}>
              <StepIcon status={status} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.4 }}>{criterion.criterion}</div>
                <div style={{ fontSize: 10, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{formatCheckStatus(criterion.status, t)}</div>
              </div>
              <EvidenceRefs refs={criterion.evidence_refs ?? []} knownRefs={result.evidence_index ?? []} onEvidence={onEvidence} missingTitle={t("result.missingEvidenceTitle")} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProcessSummary({ result, t, onEvidence }: {
  result: RR; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  const items = result.process_summary ?? [];
  return (
    <section style={panelStyle}>
      <SectionHeader>{t("result.processSummary")}</SectionHeader>
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {items.length === 0 ? (
          <div style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>{t("result.noProcessSummary")}</div>
        ) : items.map((item, index) => (
          <div key={`${item.kind}-${item.seq ?? index}-${item.step_id ?? ""}`} style={{ border: "1px solid var(--border-light)", borderRadius: 4, background: "var(--bg-inset)", padding: 12, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: processColor(item.status), flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatProcessTitle(item.title, t)}</span>
              <span style={{ marginLeft: "auto", ...microTagStyle, color: processColor(item.status) }}>{formatProcessStatus(item.status, t)}</span>
            </div>
            <div style={{ marginTop: 7, color: "var(--fg-secondary)", fontSize: 12, lineHeight: 1.45 }}>{formatProcessDetail(item.detail, t)}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {item.seq !== undefined && <span style={microTagStyle}>#{item.seq}</span>}
              {item.step_id && <span style={microTagStyle}>{item.step_id}</span>}
              <EvidenceRefs refs={item.evidence_refs ?? []} knownRefs={result.evidence_index ?? []} onEvidence={onEvidence} compact />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StepTimeline({ steps, t, onEvidence }: { steps: RunStep[]; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void }) {
  return (
    <section style={panelStyle}>
      <SectionHeader>{t("result.timeline")}</SectionHeader>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {steps.length === 0 ? (
          <div style={{ padding: 14, background: "var(--bg-card)", color: "var(--fg-tertiary)", fontSize: 12 }}>{t("result.noSteps")}</div>
        ) : steps.map(step => (
          <div key={step.id} style={{ background: "var(--bg-card)", padding: "10px 12px", display: "grid", gridTemplateColumns: "26px 96px minmax(0, 1fr) minmax(180px, auto)", gap: 10, alignItems: "center" }}>
            <StepIcon status={stepStatusIcon(step.status)} />
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>{step.id}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>{formatStepStatus(step.status, t)}</div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={microTagStyle}>{formatActionLabel(step.capability, t)}</span>
                <span style={microTagStyle}>{formatActionLabel(step.action, t)}</span>
                {typeof step.exit_code === "number" && <span style={step.exit_code === 0 ? microTagOkStyle : microTagBadStyle}>exit {step.exit_code}</span>}
                {step.timeout_sec !== undefined && <span style={microTagStyle}>{step.timeout_sec}s</span>}
              </div>
              {step.command && <div title={step.command} style={{ marginTop: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.command}</div>}
            </div>
            <EvidenceRefs refs={step.evidence_refs ?? []} knownRefs={[]} onEvidence={onEvidence} />
          </div>
        ))}
      </div>
    </section>
  );
}

function EvidenceInspector({ result, events, selectedRef, selectedContent, tab, setTab, t, onEvidence }: {
  result: RR; events: RunEvent[]; selectedRef: string | null; selectedContent: string; tab: InspectorTab; setTab: (tab: InspectorTab) => void;
  t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  const evidence = result.evidence_index ?? [];
  const selectedMeta = selectedRef ? evidence.find(e => e.ref === selectedRef) : undefined;
  return (
    <section style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--fg-tertiary)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>{t("result.evidenceInspector")}</div>
          <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", wordBreak: "break-all" }}>{selectedRef ?? t("result.noEvidenceSelected")}</div>
        </div>
        {selectedMeta && <span style={microTagStyle}>{selectedMeta.kind}{selectedMeta.bytes ? ` / ${formatBytes(selectedMeta.bytes)}` : ""}</span>}
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {(["evidence", "process", "events", "debug"] as InspectorTab[]).map(item => (
          <button key={item} onClick={() => setTab(item)} style={{ flex: 1, border: "none", borderRight: item === "debug" ? "none" : "1px solid var(--border)", background: tab === item ? "var(--bg-inset)" : "transparent", color: tab === item ? "var(--fg)" : "var(--fg-secondary)", padding: "8px 10px", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {t(`result.tab.${item}`)}
          </button>
        ))}
      </div>
      {tab === "evidence" && (
        <div style={{ display: "grid", gridTemplateRows: "auto minmax(220px, 48vh)" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--border-light)", display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 96, overflow: "auto" }}>
            {evidence.length === 0 ? <span style={mutedStyle}>{t("result.noEvidence")}</span> : evidence.map(ref => (
              <button key={ref.ref} onClick={() => onEvidence(ref.ref)} style={{ ...refButtonStyle, borderColor: selectedRef === ref.ref ? "var(--blue)" : "var(--border)", color: selectedRef === ref.ref ? "var(--blue)" : "var(--fg-secondary)" }}>{ref.ref}</button>
            ))}
          </div>
          <pre style={terminalStyle}>{selectedContent || t("result.noEvidenceSelected")}</pre>
        </div>
      )}
      {tab === "process" && (
        <div style={{ maxHeight: "58vh", overflow: "auto", padding: "8px 12px" }}>
          {(result.process_summary ?? []).length > 0
            ? result.process_summary!.map((item, index) => <ProcessLine key={`${item.kind}-${item.seq ?? index}`} item={item} t={t} onEvidence={onEvidence} knownRefs={result.evidence_index ?? []} />)
            : events.map(event => <EventLine key={event.seq} event={event} t={t} onEvidence={onEvidence} />)}
        </div>
      )}
      {tab === "events" && (
        <RawEventAudit events={events} t={t} onEvidence={onEvidence} />
      )}
      {tab === "debug" && (
        <pre style={terminalStyle}>{JSON.stringify(result, null, 2)}</pre>
      )}
    </section>
  );
}

function ProcessLine({ item, t, onEvidence, knownRefs }: {
  item: ProcessSummaryItem; t: (key: string) => string; onEvidence: (ref: string) => void; knownRefs: EvidenceRef[];
}) {
  return (
    <div style={{ padding: "7px 0", borderBottom: "1px solid var(--border-light)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: processColor(item.status), flexShrink: 0 }} />
        <span style={{ color: "var(--fg)", fontWeight: 700, fontSize: 11 }}>{formatProcessTitle(item.title, t)}</span>
        {item.seq !== undefined && <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>#{item.seq}</span>}
      </div>
      <div style={{ marginTop: 3, color: "var(--fg-secondary)", fontSize: 11, lineHeight: 1.4 }}>{formatProcessDetail(item.detail, t)}</div>
      <EvidenceRefs refs={item.evidence_refs ?? []} knownRefs={knownRefs} onEvidence={onEvidence} compact />
    </div>
  );
}

function RelatedHistory({ result, t }: { result: RR; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const history = result.related_history ?? [];
  if (history.length === 0) return null;
  return (
    <section style={panelStyle}>
      <SectionHeader>{t("result.relatedHistory")}</SectionHeader>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {history.slice(0, 5).map(item => (
          <div key={item.episode_id} style={{ background: "var(--bg-card)", padding: "10px 12px", display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) 120px", gap: 12, alignItems: "center" }}>
            <span style={{ ...microTagStyle, width: "fit-content", color: item.result === "completed" ? "var(--green)" : item.result === "failed" ? "var(--red)" : "var(--fg-secondary)" }}>{formatRunResult(item.result, t)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.run_id}</div>
              <div style={{ fontSize: 12, color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.summary}</div>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)", textAlign: "right" }}>{formatDate(item.recorded_at)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RawEvents({ events, open, setOpen, t, onEvidence }: {
  events: RunEvent[]; open: boolean; setOpen: (open: boolean) => void; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <section>
      <button onClick={() => setOpen(!open)} style={{ background: "transparent", border: "none", padding: 0, color: "var(--fg-tertiary)", cursor: "pointer", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>
        {t("result.allEvents")} ({events.length}) {open ? "v" : ">"}
      </button>
      {open && (
        <RawEventAudit events={events} t={t} onEvidence={onEvidence} maxHeight={520} />
      )}
    </section>
  );
}

function RawEventAudit({ events, t, onEvidence, maxHeight = "58vh" }: {
  events: RunEvent[]; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void; maxHeight?: number | string;
}) {
  if (events.length === 0) {
    return <div style={{ padding: 14, color: "var(--fg-tertiary)", fontSize: 12 }}>{t("result.noRawEvents")}</div>;
  }
  return (
    <div style={{ maxHeight, overflow: "auto", padding: "8px 12px" }}>
      {events.map(event => <RawEventCard key={event.seq} event={event} t={t} onEvidence={onEvidence} />)}
    </div>
  );
}

function RawEventCard({ event, t, onEvidence }: {
  event: RunEvent; t: (key: string, vars?: Record<string, string | number>) => string; onEvidence: (ref: string) => void;
}) {
  const payload = event.payload ?? {};
  const color = event.severity === "fatal" ? "var(--red)" : event.severity === "warning" ? "var(--amber)" : event.type === "llm_call" ? "var(--blue)" : "var(--fg-tertiary)";
  return (
    <details style={{ borderBottom: "1px solid var(--border-light)", padding: "8px 0" }} open={event.type === "llm_call"}>
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <div style={{ display: "grid", gridTemplateColumns: "42px minmax(88px, auto) minmax(0, 1fr) auto", gap: 8, alignItems: "center" }}>
          <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10 }}>#{event.seq}</span>
          <span style={{ ...microTagStyle, color }}>{formatEventType(event.type, t)}</span>
          <span style={{ minWidth: 0, color: "var(--fg-secondary)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{event.summary}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>{formatDate(event.time)}</span>
        </div>
      </summary>
      <div style={{ marginTop: 8, paddingLeft: 50, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {event.step_id && <span style={microTagStyle}>{event.step_id}</span>}
          {event.severity && <span style={{ ...microTagStyle, color }}>{event.severity}</span>}
          {event.type === "llm_call" && <LlmMeta payload={payload} t={t} />}
          <EvidenceRefs refs={event.evidence_refs ?? []} knownRefs={[]} onEvidence={onEvidence} compact />
        </div>
        {event.type === "llm_call" ? <LlmAudit payload={payload} t={t} /> : null}
        <PayloadTable payload={payload} t={t} />
      </div>
    </details>
  );
}

function LlmMeta({ payload, t }: { payload: Record<string, unknown>; t: (key: string) => string }) {
  return (
    <>
      <span style={microTagStyle}>{stringPayload(payload, "role") ?? "llm"}</span>
      <span style={microTagStyle}>{numberPayload(payload, "input_chars") ?? 0} in</span>
      <span style={microTagStyle}>{numberPayload(payload, "output_chars") ?? 0} out</span>
      {booleanPayload(payload, "fallback") && <span style={{ ...microTagStyle, color: "var(--amber)" }}>{t("result.llmFallback")}</span>}
      {stringPayload(payload, "source") && <span style={microTagStyle}>{stringPayload(payload, "source")}</span>}
    </>
  );
}

function LlmAudit({ payload, t }: { payload: Record<string, unknown>; t: (key: string) => string }) {
  const messages = messagesPreview(payload["messages_preview"]);
  const output = stringPayload(payload, "raw_content");
  const error = stringPayload(payload, "error");
  const auditMissing = messages.length === 0 || output === undefined;
  if (auditMissing) {
    return <AuditBlock label={t("result.llmAuditMissing")} value={JSON.stringify(payload, null, 2)} tone="warn" />;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
      {messages.map((message, index) => (
        <AuditBlock key={`${message.role}-${index}`} label={`${t("result.llmInput")} / ${message.role}`} value={message.content} />
      ))}
      <AuditBlock label={t("result.llmOutput")} value={output || t("result.emptyOutput")} tone={output ? "normal" : "warn"} />
      {error && <AuditBlock label={t("result.error")} value={error} tone="warn" />}
    </div>
  );
}

function AuditBlock({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warn" }) {
  return (
    <div>
      <div style={{ ...labelStyle, marginBottom: 4, color: tone === "warn" ? "var(--amber)" : labelStyle.color }}>{label}</div>
      <pre style={{ ...auditPreStyle, borderColor: tone === "warn" ? "rgba(245,158,11,.35)" : "var(--border-light)" }}>{value}</pre>
    </div>
  );
}

function PayloadTable({ payload, t }: { payload: Record<string, unknown>; t: (key: string) => string }) {
  const entries = Object.entries(payload).filter(([key]) => !["messages_preview", "input_preview", "raw_content"].includes(key));
  if (entries.length === 0) return null;
  return (
    <details>
      <summary style={{ cursor: "pointer", color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{t("result.payload")}</summary>
      <pre style={{ ...auditPreStyle, marginTop: 6 }}>{JSON.stringify(Object.fromEntries(entries), null, 2)}</pre>
    </details>
  );
}

function EventLine({ event, t, onEvidence }: { event: RunEvent; t: (key: string) => string; onEvidence: (ref: string) => void }) {
  const color = event.severity === "fatal" ? "var(--red)" : event.severity === "warning" ? "var(--amber)" : "var(--fg-tertiary)";
  return (
    <div style={{ padding: "5px 0", borderBottom: "1px solid var(--border-light)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 30 }}>#{event.seq}</span>
        <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10 }}>{formatEventType(event.type, t)}</span>
        {event.step_id && <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>{event.step_id}</span>}
      </div>
      <div style={{ marginTop: 2, color: "var(--fg-secondary)", fontSize: 11, lineHeight: 1.4 }}>{event.summary}</div>
      <EvidenceRefs refs={event.evidence_refs ?? []} knownRefs={[]} onEvidence={onEvidence} compact />
    </div>
  );
}

function EvidenceRefs({ refs, knownRefs, onEvidence, missingTitle, compact }: {
  refs: string[]; knownRefs: EvidenceRef[]; onEvidence: (ref: string) => void; missingTitle?: string; compact?: boolean;
}) {
  if (refs.length === 0) return null;
  const known = new Set(knownRefs.map(ref => ref.ref));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, justifyContent: compact ? "flex-start" : "flex-end", marginTop: compact ? 0 : 0 }}>
      {refs.map(ref => {
        const missing = knownRefs.length > 0 && !known.has(ref);
        return (
          <button key={ref} type="button" onClick={() => onEvidence(ref)} title={missing ? (missingTitle ?? ref) : ref} style={{ ...refButtonStyle, borderColor: missing ? "var(--amber)" : "var(--border)", color: missing ? "var(--amber)" : "var(--fg-secondary)" }}>
            {ref}{missing ? " !" : ""}
          </button>
        );
      })}
    </div>
  );
}

function MetricCell({ label, value, detail, tone, title }: { label: string; value: string; detail?: string; tone?: "ok" | "bad" | "warn" | "muted"; title?: string }) {
  const color = tone === "ok" ? "var(--green)" : tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : "var(--fg)";
  return (
    <div title={title} style={{ padding: "12px 14px", borderRight: "1px solid var(--border)", minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ color, fontFamily: "var(--font-mono)", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {detail && <div style={{ ...mutedStyle, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{detail}</div>}
    </div>
  );
}

function computeMetrics(result: RR): { criteriaTotal: number; criteriaPass: number; criteriaFail: number; evidenceCount: number } {
  const criteria = result.criteria_results ?? [];
  return {
    criteriaTotal: criteria.length,
    criteriaPass: criteria.filter(c => c.status === "pass").length,
    criteriaFail: criteria.filter(c => c.status === "fail").length,
    evidenceCount: result.evidence_index?.length ?? unique([
      ...(result.key_evidence ?? []).flatMap(e => e.evidence_refs),
      ...criteria.flatMap(c => c.evidence_refs),
      ...(result.steps ?? []).flatMap(s => s.evidence_refs),
    ]).length,
  };
}

function firstUsefulRef(result: RR): string | null {
  return result.key_evidence?.flatMap(e => e.evidence_refs)[0]
    ?? result.criteria_results?.flatMap(c => c.evidence_refs)[0]
    ?? result.steps?.flatMap(s => s.evidence_refs)[0]
    ?? result.evidence_index?.[0]?.ref
    ?? null;
}

function resultTone(state: string): Tone {
  if (state === "completed" || state === "pass") return "pass";
  if (state === "failed" || state === "fail") return "fail";
  if (state === "cancelled") return "cancelled";
  return "running";
}

function isTerminalState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "pass" || state === "fail";
}

function stepStatusIcon(status: RunStep["status"]): "done" | "running" | "fail" | "pending" {
  if (status === "completed") return "done";
  if (status === "failed") return "fail";
  if (status === "running") return "running";
  return "pending";
}

function formatEventType(type: string, t: (key: string) => string): string {
  const label = t(`event.${type}`);
  return label.startsWith("event.") ? type.replaceAll("_", " ") : label;
}

function formatActionLabel(value: string | undefined, t: (key: string) => string): string {
  if (!value) return t("result.unknown");
  const label = t(`action.${value}`);
  return label.startsWith("action.") ? value.replaceAll("_", " ") : label;
}

function formatStepStatus(status: string, t: (key: string) => string): string {
  if (status === "completed") return t("step.done");
  if (status === "failed") return t("step.fail");
  if (status === "running") return t("step.running");
  return t("step.pending");
}

function formatCheckStatus(status: string, t: (key: string) => string): string {
  if (status === "pass") return t("badge.pass");
  if (status === "fail") return t("badge.fail");
  return t("result.unknown");
}

function formatProcessTitle(title: string, t: (key: string) => string): string {
  const key = `process.title.${title}`;
  const label = t(key);
  return label.startsWith("process.title.") ? title : label;
}

function formatProcessDetail(detail: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (detail.includes("LLM degraded after tool fallback")) return t("process.detail.llmFallback");
  if (detail.includes("unavailable:") && detail.includes("; device execution still used collected evidence")) {
    const error = detail.slice(detail.indexOf("unavailable:") + "unavailable:".length, detail.indexOf("; device execution")).trim();
    return t("process.detail.llmUnavailableWithError", { error });
  }
  if (detail.includes("unavailable; device execution still used collected evidence")) return t("process.detail.llmUnavailable");
  return detail
    .replace(/(\d+) lines processed/g, (_m, n: string) => t("process.detail.linesProcessed", { n }))
    .replace(/(\d+) log files available/g, (_m, n: string) => t("process.detail.logFiles", { n }))
    .replace(/(\d+) log file available/g, (_m, n: string) => t("process.detail.logFiles", { n }));
}

function formatProcessStatus(status: ProcessSummaryItem["status"], t: (key: string) => string): string {
  return t(`process.status.${status}`);
}

function processColor(status: ProcessSummaryItem["status"]): string {
  if (status === "ok") return "var(--green)";
  if (status === "error") return "var(--red)";
  if (status === "warn") return "var(--amber)";
  return "var(--blue)";
}

function formatRunResult(status: string, t: (key: string) => string): string {
  if (status === "pass") return t("run.state.completed");
  if (status === "fail") return t("run.state.failed");
  const translated = t(`run.state.${status}`);
  return translated.startsWith("run.state.") ? status.replaceAll("_", " ") : translated;
}

function formatTargetState(state: string | undefined, t: (key: string) => string): string {
  if (!state) return "";
  const translated = t(`target.state.${state}`);
  return translated.startsWith("target.state.") ? state.replaceAll("_", " ") : translated;
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanPayload(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function messagesPreview(value: unknown): { role: string; content: string }[] {
  if (!Array.isArray(value)) return [];
  const messages: { role: string; content: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role = typeof record["role"] === "string" ? record["role"] : "message";
    const content = typeof record["content"] === "string" ? record["content"] : "";
    messages.push({ role, content });
  }
  return messages;
}

function statusRank(status: string): number {
  if (status === "fail") return 0;
  if (status === "unknown") return 1;
  return 2;
}

function shortRunId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 12)}...${runId.slice(-6)}` : runId;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function timeRange(result: RR): string {
  const started = result.timing?.started_at ? new Date(result.timing.started_at) : null;
  const ended = result.timing?.ended_at ? new Date(result.timing.ended_at) : null;
  if (!started || Number.isNaN(started.getTime())) return "";
  if (!ended || Number.isNaN(ended.getTime())) return started.toLocaleTimeString();
  return `${started.toLocaleTimeString()}-${ended.toLocaleTimeString()}`;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  borderRadius: 4,
  padding: "14px 16px",
  minWidth: 0,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "var(--fg-tertiary)",
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: 700,
  marginBottom: 5,
};

const mutedStyle: React.CSSProperties = {
  color: "var(--fg-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

const microTagStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid var(--border-light)",
  background: "var(--bg-inset)",
  borderRadius: 3,
  padding: "2px 6px",
  color: "var(--fg-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

const microTagOkStyle: React.CSSProperties = { ...microTagStyle, color: "var(--green)" };
const microTagBadStyle: React.CSSProperties = { ...microTagStyle, color: "var(--red)" };

const refButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-inset)",
  borderRadius: 3,
  padding: "2px 6px",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--fg-secondary)",
  cursor: "pointer",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const terminalStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  overflow: "auto",
  background: "var(--bg-terminal)",
  color: "rgba(255,255,255,.78)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
};

const auditPreStyle: React.CSSProperties = {
  margin: 0,
  border: "1px solid var(--border-light)",
  borderRadius: 4,
  padding: "9px 10px",
  maxHeight: 220,
  overflow: "auto",
  background: "var(--bg-terminal)",
  color: "rgba(255,255,255,.78)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
};
