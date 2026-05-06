import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { api, type RunSummary, fetchAllHistory } from "./api";
import { useT } from "./i18n";
import { EmptyState, PageHeader, StatusBadge, inputStyle } from "./shared";
import { displayElapsedSec, isTerminalRunState } from "./time";

type Filter = "all" | "pass" | "fail" | "running" | "cancelled";
type Tone = "pass" | "fail" | "running" | "cancelled" | "pending";
type TFunction = (key: string, vars?: Record<string, string | number>) => string;

const panelStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  borderRadius: 4,
  overflow: "hidden",
};

const tableHeaderStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  background: "#fbfbf9",
  color: "var(--fg-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".05em",
  alignItems: "center",
};

const tableRowStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-light)",
  background: "var(--bg-card)",
  alignItems: "center",
};

const mutedMonoStyle: CSSProperties = {
  color: "var(--fg-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

const baseGridColumns = "96px minmax(180px, 1.05fr) minmax(120px, .7fr) minmax(180px, 1fr) minmax(130px, .75fr) minmax(120px, .7fr) 166px";
const batchGridColumns = `34px ${baseGridColumns}`;

function historyTableHeaderStyle(batchMode: boolean): CSSProperties {
  return {
    ...tableHeaderStyle,
    gridTemplateColumns: batchMode ? batchGridColumns : baseGridColumns,
    minWidth: batchMode ? 1040 : 980,
  };
}

function historyTableRowStyle(batchMode: boolean): CSSProperties {
  return {
    ...tableRowStyle,
    gridTemplateColumns: batchMode ? batchGridColumns : baseGridColumns,
    minWidth: batchMode ? 1040 : 980,
  };
}

export function History({ onViewRun, onViewResult, onBack }: {
  onViewRun: (id: string) => void;
  onViewResult: (id: string) => void;
  onBack: () => void;
}) {
  const { t, fmtTime } = useT();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetchAllHistory()
      .then(r => { if (!cancelled) setRuns(r); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => summarizeRuns(runs), [runs]);
  const filtered = useMemo(() => filterRuns(runs, filter, search), [runs, filter, search]);
  const filters = useMemo(() => filterOptions(t, stats), [t, stats]);
  const filteredTerminalRuns = useMemo(() => filtered.filter(isTerminalRun), [filtered]);
  const selectedRuns = useMemo(() => runs.filter(run => selectedRunIds.includes(run.run_id) && isTerminalRun(run)), [runs, selectedRunIds]);
  const allFilteredTerminalSelected = filteredTerminalRuns.length > 0 && filteredTerminalRuns.every(run => selectedRunIds.includes(run.run_id));

  useEffect(() => {
    setSelectedRunIds(current => current.filter(id => runs.some(run => run.run_id === id && isTerminalRun(run))));
  }, [runs]);

  useEffect(() => {
    if (!runs.some(run => !isTerminalRunState(run.state))) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runs]);

  function enterBatchMode(): void {
    setBatchMode(true);
  }

  function exitBatchMode(): void {
    if (bulkDeleting) return;
    setBatchMode(false);
    setSelectedRunIds([]);
    setDeleteError(null);
  }

  async function deleteRun(run: RunSummary): Promise<void> {
    if (!isTerminalRun(run)) return;
    if (!window.confirm(t("history.deleteConfirm", { run: run.run_id }))) return;

    setDeletingRunId(run.run_id);
    setDeleteError(null);
    try {
      await api.deleteRun(run.run_id);
      setRuns(current => current.filter(item => item.run_id !== run.run_id));
    } catch (e) {
      setDeleteError(`${t("history.deleteFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingRunId(null);
    }
  }

  async function deleteSelectedRuns(): Promise<void> {
    if (selectedRuns.length === 0 || bulkDeleting) return;
    if (!window.confirm(t("history.bulkDeleteConfirm", { n: selectedRuns.length }))) return;

    setBulkDeleting(true);
    setDeleteError(null);
    const failed: string[] = [];
    for (const run of selectedRuns) {
      setDeletingRunId(run.run_id);
      try {
        await api.deleteRun(run.run_id);
      } catch {
        failed.push(run.run_id);
      }
    }
    const deletedIds = selectedRuns.map(run => run.run_id).filter(id => !failed.includes(id));
    setRuns(current => current.filter(run => !deletedIds.includes(run.run_id)));
    setSelectedRunIds(current => current.filter(id => failed.includes(id)));
    if (failed.length > 0) {
      setDeleteError(t("history.bulkDeleteFailed", { n: failed.length }));
    }
    setDeletingRunId(null);
    setBulkDeleting(false);
  }

  function toggleRunSelected(run: RunSummary): void {
    if (!isTerminalRun(run) || bulkDeleting) return;
    setSelectedRunIds(current => current.includes(run.run_id) ? current.filter(id => id !== run.run_id) : [...current, run.run_id]);
  }

  function toggleFilteredSelection(): void {
    if (bulkDeleting || filteredTerminalRuns.length === 0) return;
    setSelectedRunIds(current => {
      if (filteredTerminalRuns.every(run => current.includes(run.run_id))) {
        return current.filter(id => !filteredTerminalRuns.some(run => run.run_id === id));
      }
      return Array.from(new Set([...current, ...filteredTerminalRuns.map(run => run.run_id)]));
    });
  }

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <PageHeader title={t("history.title")} subtitle={t("history.loading")} onBack={onBack} />
        <HistorySkeleton />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeIn .2s ease both" }}>
      <PageHeader title={t("history.title")} subtitle={t("history.subtitle")} onBack={onBack} />

      <SummaryStrip stats={stats} t={t} />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {filters.map(item => (
            <button key={item.key} type="button" onClick={() => setFilter(item.key)} style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: filter === item.key ? "var(--fg)" : "var(--bg-card)",
              color: filter === item.key ? "var(--bg-card)" : "var(--fg-secondary)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
            }}>
              <span>{item.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, opacity: .7 }}>{item.count}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("history.search")}
          style={{ ...inputStyle, width: 260, marginLeft: "auto", padding: "7px 10px", fontSize: 12 }}
        />
        <button type="button" onClick={batchMode ? exitBatchMode : enterBatchMode} disabled={filteredTerminalRuns.length === 0 && !batchMode} style={{
          border: "1px solid var(--border)",
          background: batchMode ? "var(--fg)" : "var(--bg-card)",
          color: batchMode ? "var(--bg-card)" : "var(--fg-secondary)",
          borderRadius: 4,
          padding: "7px 10px",
          cursor: filteredTerminalRuns.length === 0 && !batchMode ? "default" : "pointer",
          fontSize: 11,
          fontWeight: 800,
          whiteSpace: "nowrap",
        }}>
          {batchMode ? t("history.doneManaging") : t("history.manage")}
        </button>
      </div>

      {batchMode && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          border: "1px solid var(--border)",
          borderLeft: "3px solid var(--fg-tertiary)",
          background: "var(--bg-inset)",
          borderRadius: 4,
          padding: "7px 10px",
          flexWrap: "wrap",
        }}>
          <span style={{ color: "var(--fg-secondary)", fontSize: 12, fontWeight: 800 }}>{t("history.manageMode")}</span>
          <span style={{ ...mutedMonoStyle }}>{t("history.selectableCount", { n: filteredTerminalRuns.length })}</span>
          <span style={{ ...mutedMonoStyle }}>{t("history.selectedCount", { n: selectedRuns.length })}</span>
          <button type="button" onClick={() => void deleteSelectedRuns()} disabled={selectedRuns.length === 0 || bulkDeleting} style={{
            marginLeft: "auto",
            border: "1px solid color-mix(in srgb, var(--red) 38%, var(--border))",
            background: selectedRuns.length === 0 || bulkDeleting ? "var(--bg-inset)" : "var(--bg-card)",
            color: selectedRuns.length === 0 || bulkDeleting ? "var(--fg-tertiary)" : "var(--red)",
            borderRadius: 4,
            padding: "6px 10px",
            cursor: selectedRuns.length === 0 || bulkDeleting ? "default" : "pointer",
            fontSize: 11,
            fontWeight: 800,
          }}>
            {bulkDeleting ? t("history.bulkDeleting") : t("history.bulkDelete")}
          </button>
        </div>
      )}

      {deleteError && (
        <div role="alert" style={{
          border: "1px solid color-mix(in srgb, var(--red) 35%, var(--border))",
          background: "color-mix(in srgb, var(--red) 8%, var(--bg-card))",
          color: "var(--red)",
          borderRadius: 4,
          padding: "8px 10px",
          fontSize: 12,
          fontWeight: 700,
        }}>
          {deleteError}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon="-" title={runs.length === 0 ? t("history.empty") : t("history.noResults")} />
      ) : (
        <div style={{ ...panelStyle, overflowX: "auto" }}>
          <div style={historyTableHeaderStyle(batchMode)}>
            {batchMode && (
              <input
                type="checkbox"
                checked={allFilteredTerminalSelected}
                onChange={toggleFilteredSelection}
                disabled={bulkDeleting || filteredTerminalRuns.length === 0}
                title={t("history.selectFinished")}
                aria-label={t("history.selectFinished")}
              />
            )}
            <span>{t("history.colResult")}</span>
            <span>{t("history.colRun")}</span>
            <span>{t("history.colTarget")}</span>
            <span>{t("history.colArtifact")}</span>
            <span>{t("history.colEvidence")}</span>
            <span>{t("history.colTime")}</span>
            <span>{t("history.colAction")}</span>
          </div>
          {filtered.map(run => (
            <HistoryRow
              key={`${run.target}-${run.run_id}`}
              run={run}
              t={t}
              fmtTime={fmtTime}
              onOpen={() => isTerminalRun(run) ? onViewResult(run.run_id) : onViewRun(run.run_id)}
              onDelete={isTerminalRun(run) ? () => void deleteRun(run) : undefined}
              deleting={deletingRunId === run.run_id}
              selected={selectedRunIds.includes(run.run_id)}
              onSelect={() => toggleRunSelected(run)}
              bulkDeleting={bulkDeleting}
              batchMode={batchMode}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}

      <div style={{ ...mutedMonoStyle, textAlign: "center" }}>
        {t("history.showing")} {filtered.length} {t("history.of")} {runs.length}
      </div>
    </div>
  );
}

function SummaryStrip({ stats, t }: { stats: HistoryStats; t: TFunction }) {
  const cards: { label: string; value: number; tone: "ok" | "bad" | "warn" | "blue" | "muted" }[] = [
    { label: t("history.countTotal"), value: stats.total, tone: "muted" },
    { label: t("history.countPassed"), value: stats.pass, tone: "ok" },
    { label: t("history.countFailed"), value: stats.fail, tone: "bad" },
    { label: t("history.countRunning"), value: stats.running, tone: "blue" },
    { label: t("history.countEvidence"), value: stats.withEvidence, tone: "warn" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 1, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {cards.map(card => <SummaryMetric key={card.label} {...card} />)}
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: "ok" | "bad" | "warn" | "blue" | "muted" }) {
  const color = tone === "ok" ? "var(--green)" : tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : tone === "blue" ? "var(--blue)" : "var(--fg-secondary)";
  return (
    <div style={{ background: "var(--bg-card)", padding: "12px 14px" }}>
      <div style={{ color, fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 20, lineHeight: 1 }}>{value}</div>
      <div style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10, marginTop: 5 }}>{label}</div>
    </div>
  );
}

function HistoryRow({ run, t, fmtTime, onOpen, onDelete, deleting, selected, onSelect, bulkDeleting, batchMode, nowMs }: {
  run: RunSummary;
  t: TFunction;
  fmtTime: (sec: number) => string;
  onOpen: () => void;
  onDelete: (() => void) | undefined;
  deleting: boolean;
  selected: boolean;
  onSelect: () => void;
  bulkDeleting: boolean;
  batchMode: boolean;
  nowMs: number;
}) {
  const tone = runTone(run);
  const selectable = isTerminalRun(run);
  const evidenceCount = run.key_evidence?.length ?? 0;
  const pitfallCount = run.pitfalls?.length ?? 0;
  const suggestionCount = run.suggestions?.length ?? 0;
  const elapsed = displayElapsedSec(run, nowMs);
  return (
    <div
      style={historyTableRowStyle(batchMode)}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "var(--bg-card)"; }}
    >
      {batchMode && (
        <div>
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            disabled={!selectable || bulkDeleting}
            title={selectable ? t("history.selectRun") : t("history.runningNoDelete")}
            aria-label={selectable ? t("history.selectRun") : t("history.runningNoDelete")}
          />
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ResultDot tone={tone} />
        <StatusBadge tone={tone}>{t(`badge.${tone}`)}</StatusBadge>
      </div>

      <div style={{ minWidth: 0 }}>
        <button type="button" onClick={onOpen} style={{
          border: 0,
          padding: 0,
          background: "transparent",
          color: "var(--fg)",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 700,
          textAlign: "left",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>{run.run_id}</button>
        <div title={run.summary} style={{ color: "var(--fg-tertiary)", fontSize: 11, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.summary || t("history.noSummary")}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.target}</div>
        <div style={mutedMonoStyle}>{formatRunState(run.state, t)}</div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div title={run.artifact_ref} style={{ fontSize: 11, color: "var(--fg-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.artifact_ref || t("history.noArtifact")}
        </div>
        <div style={mutedMonoStyle}>{run.task || t("history.manualTask")}</div>
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", minWidth: 0 }}>
        <MicroTag tone={evidenceCount > 0 ? "ok" : "muted"}>{evidenceCount > 0 ? t("history.evidenceCount", { n: evidenceCount }) : t("history.none")}</MicroTag>
        {pitfallCount > 0 && <MicroTag tone="bad">{t("history.issueCount", { n: pitfallCount })}</MicroTag>}
        {suggestionCount > 0 && <MicroTag tone="blue">{t("history.suggestionCount", { n: suggestionCount })}</MicroTag>}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-mono)", color: "var(--fg-secondary)", fontSize: 11 }}>{formatRecordedAt(run.recorded_at, t)}</div>
        <div style={mutedMonoStyle}>{elapsed > 0 ? fmtTime(elapsed) : "-"}</div>
      </div>

      <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 6 }}>
        <button type="button" onClick={onOpen} style={{
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
          color: "var(--fg-secondary)",
          borderRadius: 4,
          padding: "6px 9px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}>
          {isTerminalRun(run) ? t("history.openResult") : t("history.openMonitor")}
        </button>
        {onDelete && (
          <button type="button" onClick={onDelete} disabled={deleting} style={{
            border: "1px solid color-mix(in srgb, var(--red) 38%, var(--border))",
            background: deleting ? "var(--bg-inset)" : "var(--bg-card)",
            color: deleting ? "var(--fg-tertiary)" : "var(--red)",
            borderRadius: 4,
            padding: "6px 9px",
            cursor: deleting ? "default" : "pointer",
            fontSize: 11,
            fontWeight: 800,
            whiteSpace: "nowrap",
          }}>
            {deleting ? t("history.deleting") : t("history.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

function MicroTag({ tone, children }: { tone: "ok" | "bad" | "blue" | "muted"; children: string }) {
  const color = tone === "ok" ? "var(--green)" : tone === "bad" ? "var(--red)" : tone === "blue" ? "var(--blue)" : "var(--fg-tertiary)";
  return (
    <span style={{
      border: "1px solid var(--border-light)",
      background: "var(--bg-inset)",
      color,
      borderRadius: 3,
      padding: "2px 6px",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function ResultDot({ tone }: { tone: Tone }) {
  const color = tone === "pass" ? "var(--green)" : tone === "fail" ? "var(--red)" : tone === "running" ? "var(--blue)" : tone === "cancelled" ? "var(--fg-tertiary)" : "var(--amber)";
  return <span style={{ width: 7, height: 7, borderRadius: 7, background: color, flexShrink: 0 }} />;
}

type HistoryStats = {
  total: number;
  pass: number;
  fail: number;
  running: number;
  cancelled: number;
  withEvidence: number;
};

function summarizeRuns(runs: RunSummary[]): HistoryStats {
  return {
    total: runs.length,
    pass: runs.filter(r => runTone(r) === "pass").length,
    fail: runs.filter(r => runTone(r) === "fail").length,
    running: runs.filter(r => runTone(r) === "running").length,
    cancelled: runs.filter(r => runTone(r) === "cancelled").length,
    withEvidence: runs.filter(r => (r.key_evidence?.length ?? 0) > 0).length,
  };
}

function filterOptions(t: TFunction, stats: HistoryStats): { key: Filter; label: string; count: number }[] {
  return [
    { key: "all", label: t("history.filterAll"), count: stats.total },
    { key: "running", label: t("history.filterRunning"), count: stats.running },
    { key: "pass", label: t("history.filterPass"), count: stats.pass },
    { key: "fail", label: t("history.filterFail"), count: stats.fail },
    { key: "cancelled", label: t("history.filterCancelled"), count: stats.cancelled },
  ];
}

function filterRuns(runs: RunSummary[], filter: Filter, search: string): RunSummary[] {
  const q = search.trim().toLowerCase();
  return runs.filter(run => {
    if (filter !== "all" && filter !== runToneFilter(run)) return false;
    if (!q) return true;
    return [
      run.run_id,
      run.target,
      run.summary ?? "",
      run.artifact_ref ?? "",
      run.task ?? "",
      ...(run.key_evidence ?? []).map(item => item.summary),
      ...(run.suggestions ?? []),
      ...(run.pitfalls ?? []),
    ].some(value => value.toLowerCase().includes(q));
  });
}

function runToneFilter(run: RunSummary): Filter {
  const tone = runTone(run);
  if (tone === "pass") return "pass";
  if (tone === "fail") return "fail";
  if (tone === "cancelled") return "cancelled";
  if (tone === "running") return "running";
  return "all";
}

function runTone(run: RunSummary): Tone {
  const state = run.state;
  if (state === "completed" || state === "pass") return "pass";
  if (state === "failed" || state === "fail") return "fail";
  if (state === "cancelled") return "cancelled";
  if (state === "running" || state === "paused" || state === "planning" || state === "collecting_evidence" || state === "finalizing") return "running";
  return "pending";
}

function isTerminalRun(run: RunSummary): boolean {
  return ["completed", "failed", "cancelled", "pass", "fail"].includes(run.state);
}

function formatRunState(state: string, t: TFunction): string {
  if (state === "pass") return t("run.state.completed");
  if (state === "fail") return t("run.state.failed");
  const translated = t(`run.state.${state}`);
  return translated.startsWith("run.state.") ? state.replaceAll("_", " ") : translated;
}

function formatRecordedAt(value: string | undefined, t: TFunction): string {
  if (!value) return t("history.unknownTime");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (diffSec < 60) return t("history.now");
  if (diffSec < 3600) return t("time.minAgo", { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t("time.hrAgo", { n: Math.floor(diffSec / 3600) });
  return date.toLocaleString();
}

function HistorySkeleton() {
  return (
    <div style={panelStyle}>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-light)" }}>
          <div className="skeleton" style={{ width: i % 2 === 0 ? "68%" : "84%", height: 14 }} />
        </div>
      ))}
    </div>
  );
}
