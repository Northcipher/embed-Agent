import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AutomationTask, type PreflightReport, type Target, type TargetCapabilities, type TargetProfileInput, type TaskTrigger, type ValidationSpec } from "./api";
import { useT } from "./i18n";
import { PageHeader, Field, inputStyle } from "./shared";
import {
  artifactPathForSource,
  buildSpec,
  defaultReplacePath,
  deploymentModeHint,
  deploymentModeLabel,
  deploymentRequiresArtifact,
  formatArtifactType,
  inferIntentDraft,
  type ArtifactType,
  type ArtifactSource,
  type DeploymentMode,
  type IntentDraft,
  type ReplyLanguage,
  type TFunction,
} from "./start-spec";

type Mode = "once" | "auto" | "both";
type TriggerKind = "cron" | "file_event" | "continuous";
type TargetConnectionKind = "adb" | "serial" | "fastboot" | "ssh";
type UiMessage = { key: string; vars?: Record<string, string | number>; error?: boolean } | { text: string; error?: boolean };
type TargetStats = { total: number; idle: number; busy: number; offline: number };

type LocalizedStartDefaults = {
  whatChanged: string;
  expected: string;
  successCriteria: string;
  failureCriteria: string;
};

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px solid var(--border-light)",
  background: "var(--bg-inset)",
  color: "var(--fg-secondary)",
  borderRadius: 3,
  padding: "3px 7px",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

const primaryButtonStyle = {
  background: "var(--fg)",
  color: "var(--bg-card)",
  border: "none",
  borderRadius: 4,
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
} as const;

const secondaryButtonStyle = {
  background: "var(--bg-card)",
  color: "var(--fg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
} as const;

type HostPlatform = "windows" | "mac" | "unix";

export function NewRun({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const { t, lang } = useT();
  const defaults = useMemo(() => startDefaults(t), [t]);
  const hostPlatform = useMemo(() => detectHostPlatform(), []);
  const defaultArtifact = useMemo(() => defaultArtifactPath(hostPlatform), [hostPlatform]);
  const defaultReplaceArtifact = useMemo(() => defaultReplaceArtifactPath(hostPlatform), [hostPlatform]);
  const defaultWatch = useMemo(() => defaultWatchPattern(hostPlatform), [hostPlatform]);
  const intentDefault = useMemo(() => intentDefaultForTarget(t, "s820-01", defaultArtifact), [defaultArtifact, t]);
  const defaultsRef = useRef(defaults);
  const intentDefaultRef = useRef(intentDefault);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia("(max-width: 920px)").matches);
  const [mode, setMode] = useState<Mode>("once");
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("");
  const [caps, setCaps] = useState<TargetCapabilities | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);

  const [intentText, setIntentText] = useState(intentDefault);
  const [manualTarget, setManualTarget] = useState(false);
  const [judgementOpen, setJudgementOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [whatChanged, setWhatChanged] = useState(defaults.whatChanged);
  const [expected, setExpected] = useState(defaults.expected);
  const [artifactSource, setArtifactSource] = useState<ArtifactSource>("path");
  const [artifactPath, setArtifactPath] = useState(defaultArtifact);
  const [latestBuild, setLatestBuild] = useState("ci://s820/nightly/latest-successful/boot.img");
  const [watchPattern, setWatchPattern] = useState(defaultWatch);
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>("flash");
  const [artifactType, setArtifactType] = useState<ArtifactType>("firmware");
  const [replacePath, setReplacePath] = useState("/data/local/tmp/boot.img");
  const [replacePathTouched, setReplacePathTouched] = useState(false);
  const [flashTool, setFlashTool] = useState("fastboot");
  const [flashPartition, setFlashPartition] = useState("boot");
  const [maxDur, setMaxDur] = useState(180);
  const [allowShell, setAllowShell] = useState(true);
  const [successCriteria, setSuccessCriteria] = useState(defaults.successCriteria);
  const [failureCriteria, setFailureCriteria] = useState(defaults.failureCriteria);
  const [replyLanguage, setReplyLanguage] = useState<ReplyLanguage>(lang);
  const [replyLanguageTouched, setReplyLanguageTouched] = useState(false);

  const [taskName, setTaskName] = useState("s820-nightly-boot-validation");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("cron");
  const [cron, setCron] = useState("30 2 * * 1-5");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [filePattern, setFilePattern] = useState(defaultWatch);
  const [overlap, setOverlap] = useState<AutomationTask["policy"]["overlap"]>("skip_if_target_busy");
  const [failure, setFailure] = useState<AutomationTask["policy"]["failure"]>("notify_and_keep_enabled");
  const [status, setStatus] = useState<UiMessage | null>(null);
  const [managingTargets, setManagingTargets] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);
  const [newTargetId, setNewTargetId] = useState("lab-board-01");
  const [newTargetName, setNewTargetName] = useState("Lab Board 01");
  const [newTargetKind, setNewTargetKind] = useState<TargetConnectionKind>("adb");
  const [adbDeviceId, setAdbDeviceId] = useState("ABC123");
  const [serialPort, setSerialPort] = useState(defaultSerialPort(hostPlatform));
  const [serialBaud, setSerialBaud] = useState(115200);
  const [fastbootDeviceId, setFastbootDeviceId] = useState("ABC123");
  const [sshHost, setSshHost] = useState("192.168.1.20");
  const [sshPort, setSshPort] = useState(22);
  const [allowTargetFlash, setAllowTargetFlash] = useState(false);
  const [allowTargetReboot, setAllowTargetReboot] = useState(true);
  const [allowTargetShell, setAllowTargetShell] = useState(true);
  const [targetStatus, setTargetStatus] = useState<UiMessage | null>(null);
  const [deletingTarget, setDeletingTarget] = useState("");
  const [rawPreviewOpen, setRawPreviewOpen] = useState(false);

  useEffect(() => {
    const previous = defaultsRef.current;
    setWhatChanged(value => value === previous.whatChanged ? defaults.whatChanged : value);
    setExpected(value => value === previous.expected ? defaults.expected : value);
    setSuccessCriteria(value => value === previous.successCriteria ? defaults.successCriteria : value);
    setFailureCriteria(value => value === previous.failureCriteria ? defaults.failureCriteria : value);
    defaultsRef.current = defaults;
  }, [defaults]);

  useEffect(() => {
    const previous = intentDefaultRef.current;
    setIntentText(value => value === previous ? intentDefault : value);
    intentDefaultRef.current = intentDefault;
  }, [intentDefault]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 920px)");
    const sync = (): void => setIsNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!replyLanguageTouched) setReplyLanguage(lang);
  }, [lang, replyLanguageTouched]);

  const selectedArtifactPath = useMemo(
    () => artifactPathForSource(artifactSource, artifactPath, latestBuild, watchPattern),
    [artifactSource, artifactPath, latestBuild, watchPattern],
  );

  useEffect(() => {
    if (!replacePathTouched) setReplacePath(defaultReplacePath(selectedArtifactPath));
  }, [selectedArtifactPath, replacePathTouched]);

  useEffect(() => {
    api.targets().then(ts => {
      setTargets(ts);
      const preferred = ts.find(item => item.state === "idle") ?? ts.find(item => item.state !== "offline") ?? ts[0];
      if (preferred) {
        setTarget(current => current || preferred.target_id);
        setIntentText(current => current === intentDefaultRef.current ? intentDefaultForTarget(t, preferred.target_id, defaultArtifact) : current);
      }
    }).catch(() => {});
    api.tasks().then(res => setTasks(res.tasks)).catch(() => {});
  }, [defaultArtifact, t]);

  const spec = useMemo(() => buildSpec({
    artifactSource,
    artifactPath,
    latestBuild,
    watchPattern,
    deploymentMode,
    artifactType,
    replacePath,
    flashTool,
    flashPartition,
    target,
    expected,
    whatChanged,
    maxDur,
    allowShell,
    successCriteria,
    failureCriteria,
    replyLanguage,
    t,
  }), [artifactSource, artifactPath, latestBuild, watchPattern, deploymentMode, artifactType, replacePath, flashTool, flashPartition, target, expected, whatChanged, maxDur, allowShell, successCriteria, failureCriteria, replyLanguage, t]);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(async () => {
      try {
        const [pf, tc] = await Promise.all([
          api.preflight(spec as unknown as Record<string, unknown>).catch(() => null),
          spec.target ? api.targetCaps(spec.target).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setPreflight(pf);
        setCaps(tc);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [spec]);

  async function submitWithMode(nextMode: Mode): Promise<void> {
    const artifactRequired = deploymentRequiresArtifact(deploymentMode);
    if (!spec.target || !spec.expected || (artifactRequired && !spec.artifact.path)) {
      setStatus({ key: artifactRequired ? "start.status.missingRequired" : "start.status.missingObserveRequired" });
      return;
    }
    if (preflight?.status === "blocked") {
      setStatus({ key: "start.status.preflightBlocked" });
      return;
    }

    setMode(nextMode);
    setStatus({ key: nextMode === "once" ? "start.status.creatingRun" : nextMode === "auto" ? "start.status.savingAutomation" : "start.status.savingAndStarting" });
    try {
      if (nextMode === "once") {
        const run = await api.validate(spec as unknown as Record<string, unknown>);
        if (run.status === "accepted" && run.run_id) onCreated(run.run_id);
        else setStatus({ text: `${run.status}: ${run.reasons?.join("; ") ?? ""}` });
        return;
      }

      const taskBody = buildTaskBody(taskName, spec, triggerKind, cron, timezone, filePattern, overlap, failure);
      const created = await api.createTask(taskBody as unknown as Record<string, unknown>);
      setTasks(prev => [created.task, ...prev.filter(task => task.name !== created.task.name)]);

      if (nextMode === "both") {
        const run = await api.runTask(created.task.name);
        if (run.status === "accepted" && run.run_id) onCreated(run.run_id);
        else setStatus({ text: `${run.status}: ${run.reasons?.join("; ") ?? ""}` });
      } else {
        setStatus({ key: "start.status.automationSaved", vars: { task: created.task.name } });
      }
    } catch (e) {
      setStatus({ key: "start.status.error", vars: { message: (e as Error).message }, error: true });
    }
  }

  async function addTarget(): Promise<void> {
    const profile = buildTargetProfile({
      targetId: newTargetId,
      displayName: newTargetName,
      kind: newTargetKind,
      adbDeviceId,
      serialPort,
      serialBaud,
      fastbootDeviceId,
      sshHost,
      sshPort,
      allowFlash: allowTargetFlash,
      allowReboot: allowTargetReboot,
      allowShell: allowTargetShell,
    });
    if (!profile.target_id || Object.keys(profile.connections).length === 0) {
      setTargetStatus({ key: "start.target.status.missing" });
      return;
    }
    setTargetStatus({ key: "start.target.status.saving" });
    try {
      await api.createTarget(profile);
      const refreshed = await api.targets();
      setTargets(refreshed);
      setTarget(profile.target_id);
      setManagingTargets(false);
      setAddingTarget(false);
      setTargetStatus({ key: "start.target.status.saved", vars: { target: profile.target_id } });
    } catch (e) {
      setTargetStatus({ key: "start.status.error", vars: { message: (e as Error).message }, error: true });
    }
  }

  async function deleteTarget(targetId: string): Promise<void> {
    const item = targets.find(current => current.target_id === targetId);
    if (!item || !canDeleteTarget(item)) return;
    if (!window.confirm(t("start.target.deleteConfirm", { target: targetId }))) return;

    setDeletingTarget(targetId);
    setTargetStatus(null);
    try {
      await api.deleteTarget(targetId);
      const refreshed = await api.targets();
      setTargets(refreshed);
      if (target === targetId) {
        const preferred = refreshed.find(current => current.state === "idle") ?? refreshed.find(current => current.state !== "offline") ?? refreshed[0];
        setTarget(preferred?.target_id ?? "");
      }
      setTargetStatus({ key: "start.target.status.deleted", vars: { target: targetId } });
    } catch (e) {
      setTargetStatus({ key: "start.target.status.deleteFailed", vars: { message: (e as Error).message }, error: true });
    } finally {
      setDeletingTarget("");
    }
  }

  const commandPreview = mode === "once"
    ? { command: "create_run", validation_spec: spec }
    : { command: mode === "auto" ? "create_task" : "create_task_then_run", ...buildTaskBody(taskName, spec, triggerKind, cron, timezone, filePattern, overlap, failure) };

  const renderedStatus = status ? renderUiMessage(status, t) : "";
  const renderedTargetStatus = targetStatus ? renderUiMessage(targetStatus, t) : "";
  const selectedTarget = targets.find(item => item.target_id === target) ?? null;
  const targetStats = useMemo<TargetStats>(() => ({
    total: targets.length,
    idle: targets.filter(item => item.state === "idle").length,
    busy: targets.filter(item => item.state === "busy").length,
    offline: targets.filter(item => item.state === "offline").length,
  }), [targets]);
  const estimateLabel = estimateDurationLabel(deploymentMode, maxDur, t);

  function applyIntent(nextText: string, options?: { forceTarget?: boolean }): void {
    setIntentText(nextText);
    const current: IntentDraft = {
      artifactSource,
      artifactPath,
      latestBuild,
      watchPattern,
      deploymentMode,
      artifactType,
      flashTool,
      flashPartition,
      target,
      expected,
      whatChanged,
      replacePath,
    };
    const draft = inferIntentDraft(nextText, current);
    const replacePathFromText = draft.replacePath !== "" && draft.replacePath !== replacePath;
    setArtifactSource(draft.artifactSource);
    setArtifactPath(draft.artifactPath);
    setLatestBuild(draft.latestBuild);
    setWatchPattern(draft.watchPattern);
    if (options?.forceTarget || !manualTarget) setTarget(draft.target);
    setExpected(draft.expected);
    setWhatChanged(draft.whatChanged);
    if (replacePathFromText) {
      setReplacePathTouched(true);
      setReplacePath(draft.replacePath);
    }
  }

  function fillExample(): void {
    setManualTarget(false);
    setReplacePathTouched(false);
    setDeploymentMode("replace");
    setArtifactType("file");
    setFlashTool("fastboot");
    setFlashPartition("boot");
    applyIntent(intentExample(t, target, defaultReplaceArtifact), { forceTarget: true });
  }

  function chooseDeploymentMode(value: DeploymentMode): void {
    setDeploymentMode(value);
  }

  function chooseArtifactType(value: ArtifactType): void {
    setArtifactType(value);
  }

  function chooseTarget(value: string): void {
    setManualTarget(true);
    setTarget(value);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeIn .2s ease both" }}>
      <PageHeader title={t("start.title")} onBack={onBack}>
        <button type="button" onClick={fillExample} style={secondaryButtonStyle}>{t("start.intent.fillExample")}</button>
      </PageHeader>

      <section style={{ display: "grid", gridTemplateColumns: isNarrow ? "1fr" : "minmax(0, 1fr) 300px", gap: 18, alignItems: "start", maxWidth: 1040, margin: "0 auto", width: "100%" }}>
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <section style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ minHeight: 42, padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: "1px solid var(--border-light)" }}>
              <div style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700 }}>{t("start.intent.label")}</div>
              <button type="button" onClick={fillExample} style={{ border: 0, background: "transparent", color: "var(--blue)", fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer" }}>{t("start.intent.exampleButton")}</button>
            </div>
            <textarea
              value={intentText}
              onChange={e => applyIntent(e.target.value)}
              rows={5}
              placeholder={t("start.intent.placeholder", { artifact: defaultReplaceArtifact })}
              spellCheck={false}
              style={{ width: "100%", minHeight: 132, border: 0, outline: 0, resize: "vertical", padding: "16px 16px 14px", color: "var(--fg)", background: "var(--bg-card)", lineHeight: 1.52, fontSize: 16, boxSizing: "border-box" }}
            />
            <div style={{ borderTop: "1px solid var(--border-light)", padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "#fcfcfa" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                <StatusChip tone={selectedTarget?.state === "busy" ? "warn" : selectedTarget?.state === "offline" ? "muted" : "ok"}>{selectedTarget ? `${selectedTarget.target_id} · ${formatTargetState(selectedTarget.state, t)}` : t("start.selectTarget")}</StatusChip>
                <StatusChip tone="blue">{deploymentModeLabel(deploymentMode, t)}</StatusChip>
                <StatusChip>{formatArtifactType(artifactType, t)}</StatusChip>
                <StatusChip>{estimateLabel}</StatusChip>
              </div>
              <button type="button" onClick={() => setJudgementOpen(!judgementOpen)} style={{ border: 0, background: "transparent", color: "var(--blue)", fontFamily: "var(--font-mono)", fontSize: 11, padding: "4px 2px", cursor: "pointer" }}>
                {t("start.intent.changeJudgement")}
              </button>
            </div>
          </section>

          {judgementOpen && (
            <section style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: 12, display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 10 }}>
                <CompactChoice label={t("start.deploymentMode")}>
                  <Segmented
                    items={[
                      ["observe", t("start.deployment.observe.short")],
                      ["flash", t("start.deployment.flash.short")],
                      ["replace", t("start.deployment.replace.short")],
                      ["install", t("start.deployment.install.short")],
                    ]}
                    value={deploymentMode}
                    onChange={value => chooseDeploymentMode(value as DeploymentMode)}
                  />
                </CompactChoice>
                <CompactChoice label={t("start.contentType")}>
                  <Segmented
                    items={[
                      ["firmware", t("start.contentType.firmware.short")],
                      ["ota", t("start.contentType.ota.short")],
                      ["apk", t("start.contentType.apk.short")],
                      ["package", t("start.contentType.package.short")],
                      ["file", t("start.contentType.file.short")],
                    ]}
                    value={artifactType}
                    onChange={value => chooseArtifactType(value as ArtifactType)}
                  />
                </CompactChoice>
              </div>
              <div style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{deploymentModeHint(deploymentMode, t)}</div>
              {(deploymentMode === "replace" || deploymentMode === "flash" || deploymentMode === "install") && (
                <ActionField label={t("start.sourcePath")}>
                  <input value={selectedArtifactPath} onChange={e => {
                    setArtifactSource("path");
                    setArtifactPath(e.target.value);
                  }} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
                </ActionField>
              )}
              {deploymentMode === "replace" && (
                <ActionField label={t("start.replacePath")}>
                  <input
                    value={replacePath}
                    onChange={e => {
                      setReplacePathTouched(true);
                      setReplacePath(e.target.value);
                    }}
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
                  />
                </ActionField>
              )}
              {deploymentMode === "flash" && (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
                  <ActionField label={t("start.flashTool")}>
                    <Segmented
                      items={[
                        ["fastboot", t("start.flashTool.fastboot")],
                        ["custom_command", t("start.flashTool.custom")],
                      ]}
                      value={flashTool}
                      onChange={setFlashTool}
                    />
                  </ActionField>
                  <ActionField label={t("start.flashPartition")}>
                    <input value={flashPartition} onChange={e => setFlashPartition(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
                  </ActionField>
                </div>
              )}
              <TargetList
                targets={targets}
                selected={target}
                onSelect={chooseTarget}
                onAdd={() => {
                  setManagingTargets(true);
                  setAddingTarget(true);
                  setAdvancedOpen(true);
                }}
                addLabel={t("start.target.manage")}
                onDelete={undefined}
                deletingTarget={deletingTarget}
                t={t}
              />
            </section>
          )}

          <details open={advancedOpen} onToggle={e => setAdvancedOpen(e.currentTarget.open)} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
            <summary style={{ listStyle: "none", padding: "12px 13px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--fg-secondary)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
              <span>{t("start.advancedMinimal")}</span>
              <span>{t("start.advancedMinimalMeta")}</span>
            </summary>
            <div style={{ borderTop: "1px solid var(--border-light)", padding: 12, display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                {deploymentRequiresArtifact(deploymentMode) && (
                  <Field label={t("start.artifact")}>
                    <input value={selectedArtifactPath} onChange={e => {
                      setArtifactSource("path");
                      setArtifactPath(e.target.value);
                    }} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
                  </Field>
                )}
                <Field label={t("start.maxDuration")}>
                  <input type="number" value={maxDur} onChange={e => setMaxDur(Number(e.target.value))} style={inputStyle} />
                </Field>
                <Field label={t("start.replyLanguage")}>
                  <Segmented
                    items={[
                      ["zh", t("start.replyLanguage.zh")],
                      ["en", t("start.replyLanguage.en")],
                    ]}
                    value={replyLanguage}
                    onChange={value => {
                      setReplyLanguageTouched(true);
                      setReplyLanguage(value as ReplyLanguage);
                    }}
                  />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <CriteriaEditor title={t("start.successTitle")} hint={t("start.lineHint")} value={successCriteria} onChange={setSuccessCriteria} />
                <CriteriaEditor title={t("start.failureTitle")} hint={t("start.lineHint")} value={failureCriteria} onChange={setFailureCriteria} />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-secondary)" }}>
                <input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} />
                {t("start.target.allowShell")}
              </label>
              {managingTargets && (
                <TargetManagementPanel
                  stats={targetStats}
                  adding={addingTarget}
                  onToggleAdd={() => setAddingTarget(!addingTarget)}
                  newTargetKind={newTargetKind}
                  setNewTargetKind={setNewTargetKind}
                  newTargetId={newTargetId}
                  setNewTargetId={setNewTargetId}
                  newTargetName={newTargetName}
                  setNewTargetName={setNewTargetName}
                  adbDeviceId={adbDeviceId}
                  setAdbDeviceId={setAdbDeviceId}
                  serialPort={serialPort}
                  setSerialPort={setSerialPort}
                  serialBaud={serialBaud}
                  setSerialBaud={setSerialBaud}
                  fastbootDeviceId={fastbootDeviceId}
                  setFastbootDeviceId={setFastbootDeviceId}
                  sshHost={sshHost}
                  setSshHost={setSshHost}
                  sshPort={sshPort}
                  setSshPort={setSshPort}
                  allowTargetShell={allowTargetShell}
                  setAllowTargetShell={setAllowTargetShell}
                  allowTargetReboot={allowTargetReboot}
                  setAllowTargetReboot={setAllowTargetReboot}
                  allowTargetFlash={allowTargetFlash}
                  setAllowTargetFlash={setAllowTargetFlash}
                  addTarget={addTarget}
                  targets={targets}
                  selected={target}
                  onSelect={chooseTarget}
                  onAdd={() => setAddingTarget(true)}
                  onDelete={deleteTarget}
                  deletingTarget={deletingTarget}
                  targetStatus={targetStatus}
                  renderedTargetStatus={renderedTargetStatus}
                  t={t}
                />
              )}
              <ReadinessGrid report={preflight} caps={caps} t={t} />
              <PreflightTimeline report={preflight} checking={checking} t={t} />
            </div>
          </details>
        </div>

        <aside style={{ position: isNarrow ? "static" : "sticky", top: 18, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ padding: "12px 13px", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700 }}>{t("start.submitSummary")}</div>
            <span style={{ color: preflight?.status === "blocked" ? "var(--red)" : preflight?.status === "warn" ? "var(--amber)" : "var(--green)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700 }}>
              {checking ? t("start.statusLabel.checking") : formatStatusLabel(preflight?.status ?? "ready", t)}
            </span>
          </div>
          <div style={{ padding: "12px 13px", display: "grid", gap: 9 }}>
            <SummaryLine label={t("start.previewDevice")} value={spec.target || t("start.selectTarget")} />
            <SummaryLine label={t("start.previewDeployment")} value={deploymentModeLabel(deploymentMode, t)} />
            <SummaryLine label={t("start.previewFile")} value={spec.artifact.path || t("history.noArtifact")} />
            <SummaryLine label={t("start.previewContentType")} value={formatArtifactType(spec.artifact.type, t)} />
            {(deploymentMode === "replace" || deploymentMode === "flash" || deploymentMode === "install") && (
              <SummaryLine label={t("start.previewSourcePath")} value={selectedArtifactPath || t("history.noArtifact")} />
            )}
            {deploymentMode === "replace" && <SummaryLine label={t("start.previewReplacePath")} value={replacePath || "-"} />}
            {deploymentMode === "flash" && <SummaryLine label={t("start.previewFlashTool")} value={flashTool || "-"} />}
            {deploymentMode === "flash" && <SummaryLine label={t("start.previewFlashPartition")} value={flashPartition || "-"} />}
            <SummaryLine label={t("start.previewExpected")} value={spec.expected || "-"} />
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--border-light)", display: "grid", gap: 8 }}>
            <button type="button" onClick={() => { void submitWithMode("once"); }} style={{ ...primaryButtonStyle, width: "100%", padding: "11px 12px", fontSize: 13 }}>{t("start.mode.once")}</button>
            <button type="button" onClick={() => setAutomationOpen(!automationOpen)} style={{ ...secondaryButtonStyle, width: "100%", padding: "10px 12px" }}>{t("start.mode.auto")}</button>
          </div>
          {automationOpen && (
            <div style={{ padding: 12, borderTop: "1px solid var(--border-light)", background: "#fcfcfa", display: "grid", gap: 9 }}>
              <Field label={t("start.execution.taskName")}>
                <input value={taskName} onChange={e => setTaskName(e.target.value)} style={inputStyle} />
              </Field>
              <Segmented
                items={[
                  ["cron", t("start.execution.scheduled")],
                  ["file_event", t("start.execution.fileEvent")],
                  ["continuous", t("start.execution.continuous")],
                ]}
                value={triggerKind}
                onChange={value => setTriggerKind(value as TriggerKind)}
              />
              {triggerKind === "cron" && <input value={cron} onChange={e => setCron(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />}
              {triggerKind === "file_event" && <input value={filePattern} onChange={e => setFilePattern(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />}
              <button type="button" onClick={() => { void submitWithMode("auto"); }} style={{ ...primaryButtonStyle, width: "100%" }}>{t("start.execution.saveAutomation")}</button>
              <button type="button" onClick={() => { void submitWithMode("both"); }} style={{ ...secondaryButtonStyle, width: "100%" }}>{t("start.mode.both")}</button>
              <OptionBlock title={t("start.execution.savedAutomation")} status={`${tasks.length}`}>
                {tasks.slice(0, 2).map(task => (
                  <TimelineRow key={task.name} code={t("start.execution.taskCode")} text={task.name} status={task.enabled ? "enabled" : "paused"} t={t} />
                ))}
                {tasks.length === 0 && <div style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>{t("start.execution.noAutomation")}</div>}
              </OptionBlock>
            </div>
          )}
          <div style={{ padding: 12, borderTop: "1px solid var(--border-light)" }}>
            <button type="button" onClick={() => setRawPreviewOpen(!rawPreviewOpen)} style={{ border: 0, background: "transparent", color: "var(--fg-tertiary)", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {rawPreviewOpen ? t("start.previewHideRaw") : t("start.previewShowRaw")}
            </button>
            {rawPreviewOpen && (
              <pre style={{ margin: "10px 0 0", background: "var(--bg-terminal)", color: "#d7d7ca", padding: 10, fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.55, overflow: "auto", maxHeight: 230 }}>{JSON.stringify(commandPreview, null, 2)}</pre>
            )}
            {status && <div style={{ marginTop: 8, color: status.error ? "var(--red)" : "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{renderedStatus}</div>}
          </div>
        </aside>
      </section>
    </div>
  );
}

function buildTaskBody(name: string, spec: ValidationSpec, triggerKind: TriggerKind, cron: string, timezone: string, filePattern: string, overlap: AutomationTask["policy"]["overlap"], failure: AutomationTask["policy"]["failure"]): {
  name: string;
  validation_spec: ValidationSpec;
  trigger: TaskTrigger;
  policy: AutomationTask["policy"];
  enabled: boolean;
} {
  const trigger: TaskTrigger = triggerKind === "cron"
    ? { kind: "cron", cron, timezone }
    : triggerKind === "file_event"
      ? { kind: "file_event", pattern: filePattern }
      : { kind: "continuous" };
  return { name, validation_spec: spec, trigger, policy: { overlap, failure }, enabled: true };
}

function startDefaults(t: TFunction): LocalizedStartDefaults {
  return {
    whatChanged: t("start.default.whatChanged"),
    expected: t("start.default.expected"),
    successCriteria: t("start.default.successCriteria"),
    failureCriteria: t("start.default.failureCriteria"),
  };
}

function intentExample(t: TFunction, targetId: string, artifactPath: string): string {
  const target = targetId || "s820-01";
  return t("start.intent.example", { target, artifact: artifactPath });
}

function intentDefaultForTarget(t: TFunction, targetId: string, artifactPath: string): string {
  const target = targetId || "s820-01";
  return t("start.intent.default", { target, artifact: artifactPath });
}

function detectHostPlatform(): HostPlatform {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  if (platform.includes("mac") || userAgent.includes("macintosh")) return "mac";
  return "unix";
}

function defaultArtifactPath(platform: HostPlatform): string {
  return platform === "windows" ? String.raw`C:\builds\s820\nightly\boot.img` : "/builds/s820/nightly/boot.img";
}

function defaultReplaceArtifactPath(platform: HostPlatform): string {
  return platform === "windows" ? String.raw`C:\temp\libcamera.so` : "/tmp/libcamera.so";
}

function defaultWatchPattern(platform: HostPlatform): string {
  return platform === "windows" ? String.raw`C:\builds\s820\dropbox\*.img` : "/builds/s820/dropbox/*.img";
}

function defaultSerialPort(platform: HostPlatform): string {
  if (platform === "windows") return "COM3";
  if (platform === "mac") return "/dev/cu.usbserial-0001";
  return "/dev/ttyUSB0";
}

function renderUiMessage(message: UiMessage, t: TFunction): string {
  return "key" in message ? t(message.key, message.vars) : message.text;
}

function formatStatusLabel(status: string, t: TFunction): string {
  return t(`start.statusLabel.${status}`);
}

function formatTargetState(state: string, t: TFunction): string {
  const translated = t(`target.state.${state}`);
  return translated.startsWith("target.state.") ? state : translated;
}

function formatPreflightMessage(check: { name: string; message: string; details?: Record<string, unknown> }, t: TFunction): string {
  if (check.name === "target") {
    if (check.message === "target is required") return t("start.preflight.targetRequired");
    if (check.message.startsWith("target not found: ")) return t("start.preflight.targetNotFound", { target: check.message.slice("target not found: ".length) });
    if (check.message === "target is offline") return t("start.preflight.targetOffline");
    if (check.message === "target is busy") return t("start.preflight.targetBusy");
    return t("start.preflight.targetReady", { state: formatTargetState(check.message, t) });
  }
  if (check.name === "artifact") {
    if (check.message === "artifact.path is required") return t("start.preflight.artifactRequired");
    if (check.message === "artifact not required for observe mode") return t("start.preflight.artifactOptional");
    if (check.message === "file exists") return t("start.preflight.fileExists");
    if (check.message === "file not readable") return t("start.preflight.fileUnreadable");
  }
  if (check.name === "capabilities" && check.message === "no active capabilities") {
    return t("start.noCapabilities");
  }
  if (check.name === "safety") {
    if (check.message === "allow_flash conflicts with no_flash") return t("start.preflight.safetyConflict");
    if (check.message === "constraints accepted") return t("start.preflight.constraintsAccepted");
  }
  return check.message;
}

function buildTargetProfile(input: {
  targetId: string;
  displayName: string;
  kind: TargetConnectionKind;
  adbDeviceId: string;
  serialPort: string;
  serialBaud: number;
  fastbootDeviceId: string;
  sshHost: string;
  sshPort: number;
  allowFlash: boolean;
  allowReboot: boolean;
  allowShell: boolean;
}): TargetProfileInput {
  const connections: Record<string, unknown> = {};
  if (input.kind === "adb" && input.adbDeviceId.trim()) connections.adb = { device_id: input.adbDeviceId.trim() };
  if (input.kind === "serial" && input.serialPort.trim()) connections.serial = { port: input.serialPort.trim(), baud: input.serialBaud };
  if (input.kind === "fastboot" && input.fastbootDeviceId.trim()) connections.fastboot = { device_id: input.fastbootDeviceId.trim() };
  if (input.kind === "ssh" && input.sshHost.trim()) connections.ssh = { host: input.sshHost.trim(), port: input.sshPort };
  const profile: TargetProfileInput = {
    target_id: input.targetId.trim(),
    connections,
    safety: {
      allow_flash: input.allowFlash,
      allow_reboot: input.allowReboot,
      allow_shell_exec: input.allowShell,
      allow_power_cycle: false,
    },
    target_hints: { boot_markers: [], fail_patterns: ["KERNEL PANIC", "Unrecoverable error"] },
  };
  if (input.displayName.trim()) profile.display_name = input.displayName.trim();
  if (input.allowFlash && input.kind === "fastboot") profile.flash = { method: "fastboot", artifact_type: "firmware" };
  return profile;
}

function Segmented({ items, value, onChange }: { items: [string, string][]; value: string; onChange: (value: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`, gap: 1, background: "var(--border)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {items.map(([id, label]) => (
        <button key={id} type="button" onClick={() => onChange(id)} style={{
          border: 0,
          background: value === id ? "var(--bg-active)" : "var(--bg-card)",
          color: value === id ? "var(--fg)" : "var(--fg-secondary)",
          padding: "8px 8px",
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
        }}>{label}</button>
      ))}
    </div>
  );
}

function CompactChoice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "116px minmax(0, 1fr)", gap: 10, alignItems: "center" }}>
      <div style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700 }}>{label}</div>
      {children}
    </div>
  );
}

function ActionField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <label style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700 }}>{label}</label>
      {children}
    </div>
  );
}

function StatusChip({ tone = "muted", children }: { tone?: "ok" | "warn" | "blue" | "muted"; children: React.ReactNode }) {
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--amber)" : tone === "blue" ? "var(--blue)" : "var(--fg-secondary)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      minHeight: 25,
      padding: "4px 8px",
      border: "1px solid var(--border)",
      borderRadius: 4,
      background: "var(--bg-inset)",
      color,
      fontSize: 11,
      fontFamily: "var(--font-mono)",
      whiteSpace: "nowrap",
      maxWidth: "100%",
    }}>{children}</span>
  );
}

function CriteriaEditor({ title, hint, value, onChange }: { title: string; hint: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={title} hint={hint}>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }} />
    </Field>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr)", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border-light)", fontSize: 11, lineHeight: 1.45 }}>
      <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>{label}</span>
      <span style={{ color: "var(--fg-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>{value}</span>
    </div>
  );
}

function formatOverlap(value: AutomationTask["policy"]["overlap"], t: TFunction): string {
  if (value === "queue_next_run") return t("start.execution.overlapQueue");
  if (value === "cancel_older_run") return t("start.execution.overlapCancel");
  return t("start.execution.overlapSkip");
}

function formatFailure(value: AutomationTask["policy"]["failure"], t: TFunction): string {
  if (value === "pause_after_3_failures") return t("start.execution.failurePause");
  if (value === "collect_extra_evidence") return t("start.execution.failureCollect");
  return t("start.execution.failureNotify");
}

function estimateDurationLabel(_mode: DeploymentMode, maxDur: number, t: TFunction): string {
  const seconds = Number.isFinite(maxDur) && maxDur > 0 ? Math.round(maxDur) : 0;
  if (seconds <= 0) return t("start.estimate.notSet");
  if (seconds < 60) return t("start.estimate.maxSec", { n: seconds });
  return t("start.estimate.maxMin", { n: Math.ceil(seconds / 60) });
}

function CapabilityChip({ label, active }: { label: string; active: boolean }) {
  return <span style={{ ...chipStyle, color: active ? "var(--green)" : "var(--fg-tertiary)" }}>{label}</span>;
}

function TargetManageHeader({ stats, adding, onToggleAdd, t }: { stats: TargetStats; adding: boolean; onToggleAdd: () => void; t: TFunction }) {
  return (
    <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{t("start.target.manageTitle")}</div>
          <div style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10, marginTop: 3 }}>{t("start.target.manageStatus", { total: stats.total })}</div>
        </div>
        <button type="button" onClick={onToggleAdd} style={adding ? secondaryButtonStyle : primaryButtonStyle}>
          {adding ? t("start.target.collapseAdd") : t("start.target.add")}
        </button>
      </div>
      <TargetStatsStrip stats={stats} t={t} />
    </div>
  );
}

function TargetManagementPanel(props: {
  stats: TargetStats;
  adding: boolean;
  onToggleAdd: () => void;
  newTargetKind: TargetConnectionKind;
  setNewTargetKind: (kind: TargetConnectionKind) => void;
  newTargetId: string;
  setNewTargetId: (value: string) => void;
  newTargetName: string;
  setNewTargetName: (value: string) => void;
  adbDeviceId: string;
  setAdbDeviceId: (value: string) => void;
  serialPort: string;
  setSerialPort: (value: string) => void;
  serialBaud: number;
  setSerialBaud: (value: number) => void;
  fastbootDeviceId: string;
  setFastbootDeviceId: (value: string) => void;
  sshHost: string;
  setSshHost: (value: string) => void;
  sshPort: number;
  setSshPort: (value: number) => void;
  allowTargetShell: boolean;
  setAllowTargetShell: (value: boolean) => void;
  allowTargetReboot: boolean;
  setAllowTargetReboot: (value: boolean) => void;
  allowTargetFlash: boolean;
  setAllowTargetFlash: (value: boolean) => void;
  addTarget: () => Promise<void>;
  targets: Target[];
  selected: string;
  onSelect: (target: string) => void;
  onAdd: () => void;
  onDelete: (target: string) => void | Promise<void>;
  deletingTarget: string;
  targetStatus: UiMessage | null;
  renderedTargetStatus: string;
  t: TFunction;
}) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 12, background: "#fbfbf9", display: "grid", gap: 12 }}>
      <TargetManageHeader stats={props.stats} adding={props.adding} onToggleAdd={props.onToggleAdd} t={props.t} />
      {props.adding && (
        <div style={{ border: "1px solid var(--border-light)", borderRadius: 4, background: "var(--bg-card)", padding: 12, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label={props.t("start.target.id")}>
              <input value={props.newTargetId} onChange={e => props.setNewTargetId(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
            <Field label={props.t("start.target.displayName")}>
              <input value={props.newTargetName} onChange={e => props.setNewTargetName(e.target.value)} style={inputStyle} />
            </Field>
            <Field label={props.t("start.target.connection")}>
              <Segmented
                items={[
                  ["adb", "ADB"],
                  ["serial", props.t("conn.serial")],
                  ["fastboot", props.t("conn.fastboot")],
                  ["ssh", "SSH"],
                ]}
                value={props.newTargetKind}
                onChange={value => props.setNewTargetKind(value as TargetConnectionKind)}
              />
            </Field>
          </div>

          {props.newTargetKind === "adb" && (
            <Field label={props.t("start.target.adbDeviceId")} hint={props.t("start.target.adbHint")}>
              <input value={props.adbDeviceId} onChange={e => props.setAdbDeviceId(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
          )}
          {props.newTargetKind === "serial" && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px", gap: 10 }}>
              <Field label={props.t("start.target.serialPath")} hint={props.t("start.target.serialHint")}>
                <input value={props.serialPort} onChange={e => props.setSerialPort(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
              </Field>
              <Field label={props.t("start.target.serialBaud")}>
                <input type="number" value={props.serialBaud} onChange={e => props.setSerialBaud(Number(e.target.value))} style={inputStyle} />
              </Field>
            </div>
          )}
          {props.newTargetKind === "fastboot" && (
            <Field label={props.t("start.target.fastbootDeviceId")}>
              <input value={props.fastbootDeviceId} onChange={e => props.setFastbootDeviceId(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
          )}
          {props.newTargetKind === "ssh" && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px", gap: 10 }}>
              <Field label={props.t("start.target.sshHost")}>
                <input value={props.sshHost} onChange={e => props.setSshHost(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
              </Field>
              <Field label={props.t("start.target.port")}>
                <input type="number" value={props.sshPort} onChange={e => props.setSshPort(Number(e.target.value))} style={inputStyle} />
              </Field>
            </div>
          )}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-secondary)", fontSize: 11 }}>
              <input type="checkbox" checked={props.allowTargetShell} onChange={e => props.setAllowTargetShell(e.target.checked)} />
              {props.t("start.target.allowShell")}
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-secondary)", fontSize: 11 }}>
              <input type="checkbox" checked={props.allowTargetReboot} onChange={e => props.setAllowTargetReboot(e.target.checked)} />
              {props.t("start.target.allowReboot")}
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-secondary)", fontSize: 11 }}>
              <input type="checkbox" checked={props.allowTargetFlash} onChange={e => props.setAllowTargetFlash(e.target.checked)} />
              {props.t("start.target.allowFlash")}
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={props.onToggleAdd} style={secondaryButtonStyle}>{props.t("start.target.cancel")}</button>
            <button type="button" onClick={() => { void props.addTarget(); }} style={primaryButtonStyle}>{props.t("start.target.save")}</button>
          </div>
        </div>
      )}

      <TargetList
        targets={props.targets}
        selected={props.selected}
        onSelect={props.onSelect}
        onAdd={props.onAdd}
        onDelete={props.onDelete}
        deletingTarget={props.deletingTarget}
        t={props.t}
      />
      {props.targetStatus && (
        <div style={{ color: props.targetStatus.error ? "var(--red)" : "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {props.renderedTargetStatus}
        </div>
      )}
    </section>
  );
}

function TargetStatsStrip({ stats, t }: { stats: TargetStats; t: TFunction }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <CompactMetric value={String(stats.total)} label={t("start.target.total")} tone="blue" />
      <CompactMetric value={String(stats.idle)} label={t("start.target.idleCount")} tone="ok" />
      <CompactMetric value={String(stats.busy)} label={t("start.target.busyCount")} tone="warn" />
      <CompactMetric value={String(stats.offline)} label={t("start.target.offlineCount")} tone="muted" />
    </div>
  );
}

function CompactMetric({ value, label, tone }: { value: string; label: string; tone: "ok" | "warn" | "blue" | "muted" }) {
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--amber)" : tone === "blue" ? "var(--blue)" : "var(--fg-tertiary)";
  return (
    <div style={{ padding: "8px 8px", borderRight: "1px solid var(--border)", background: "#fbfbf9" }}>
      <span style={{ display: "block", color, fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>{value}</span>
      <span style={{ display: "block", marginTop: 2, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{label}</span>
    </div>
  );
}

function TargetList({ targets, selected, onSelect, onAdd, addLabel, onDelete, deletingTarget, t }: {
  targets: Target[];
  selected: string;
  onSelect: (target: string) => void;
  onAdd: () => void;
  addLabel?: string;
  onDelete?: ((target: string) => void | Promise<void>) | undefined;
  deletingTarget: string;
  t: TFunction;
}) {
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {targets.map(item => (
        <TargetListItem
          key={item.target_id}
          item={item}
          selected={selected === item.target_id}
          onSelect={() => onSelect(item.target_id)}
          onDelete={onDelete ? () => onDelete(item.target_id) : undefined}
          deleting={deletingTarget === item.target_id}
          t={t}
        />
      ))}
      <div style={{ display: "flex", justifyContent: targets.length === 0 ? "space-between" : "flex-end", alignItems: "center", gap: 10, color: "var(--fg-tertiary)", fontSize: 12, border: targets.length === 0 ? "1px solid var(--border)" : "none", borderRadius: 4, padding: targets.length === 0 ? 10 : 0 }}>
        {targets.length === 0 && <span>{t("start.target.none")}</span>}
        <button type="button" onClick={onAdd} style={secondaryButtonStyle}>{addLabel ?? t("start.target.add")}</button>
      </div>
    </div>
  );
}

function TargetListItem({ item, selected, onSelect, onDelete, deleting, t }: {
  item: Target;
  selected: boolean;
  onSelect: () => void;
  onDelete?: (() => void | Promise<void>) | undefined;
  deleting: boolean;
  t: TFunction;
}) {
  const canDelete = Boolean(onDelete) && canDeleteTarget(item);
  return (
    <div style={{
      border: `1px solid ${selected ? "#7f8f74" : "var(--border)"}`,
      boxShadow: selected ? "inset 3px 0 0 #7f8f74" : "none",
      background: selected ? "#fbfcf8" : "var(--bg-card)",
      opacity: item.state === "offline" ? .55 : 1,
      borderRadius: 4,
      padding: 10,
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      gap: 10,
    }}>
      <button type="button" onClick={onSelect} style={{
        border: "none",
        background: "transparent",
        padding: 0,
        textAlign: "left",
        cursor: "pointer",
        minWidth: 0,
      }}>
        <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{item.target_id}</span>
        <span style={{ display: "block", color: "var(--fg-secondary)", fontSize: 11, lineHeight: 1.45, marginBottom: 7 }}>
          {targetSummary(item, t)}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          <CapabilityChip label="serial" active={item.serial === "connected"} />
          <CapabilityChip label="adb" active={item.adb === "online"} />
          <CapabilityChip label="fastboot" active={item.fastboot === "connected"} />
          {item.current_run_id && <span style={{ ...chipStyle, color: "var(--amber)" }}>{item.current_run_id}</span>}
        </span>
      </button>
      <span style={{ display: "grid", gap: 4, justifyItems: "end", alignContent: "start" }}>
        <StatePill state={item.state} t={t} />
        {selected && <span style={{ ...chipStyle, color: "var(--green)" }}>{t("start.target.selected")}</span>}
        {onDelete && (
          <button
            type="button"
            disabled={!canDelete || deleting}
            onClick={() => { if (canDelete && !deleting) void onDelete(); }}
            style={{
              ...chipStyle,
              background: "var(--bg-inset)",
              color: canDelete ? "var(--red)" : "var(--fg-tertiary)",
              opacity: deleting ? .65 : 1,
              cursor: canDelete && !deleting ? "pointer" : "not-allowed",
            }}
          >
            {deleting ? t("start.target.deleting") : t("start.target.delete")}
          </button>
        )}
      </span>
    </div>
  );
}

function StatePill({ state, t }: { state: string; t: TFunction }) {
  const color = state === "idle" ? "var(--green)" : state === "busy" ? "var(--amber)" : state === "offline" ? "var(--fg-tertiary)" : "var(--blue)";
  return <span style={{ borderRadius: 3, padding: "2px 7px", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, background: "var(--bg-inset)", color }}>{formatTargetState(state, t)}</span>;
}

function targetSummary(target: Target, t: TFunction): string {
  if (target.state === "busy") return t("start.target.summary.busy", { run: target.current_run_id ?? t("start.target.summary.someRun") });
  if (target.state === "offline") return t("start.target.summary.offline");
  return t("start.target.summary.idle");
}

function canDeleteTarget(target: Target): boolean {
  return !target.current_run_id && (target.state === "idle" || target.state === "offline" || target.state === "dirty");
}

function ReadinessGrid({ report, caps, t }: { report: PreflightReport | null; caps: TargetCapabilities | null; t: TFunction }) {
  const blocked = report?.status === "blocked";
  const warn = report?.status === "warn";
  return (
    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <Metric value={blocked ? "0" : warn ? t("start.metric.warn") : report ? t("start.metric.ok") : "-"} label={t("start.metric.preflight")} tone={blocked ? "bad" : warn ? "warn" : "ok"} />
      <Metric value={String(caps?.capabilities.length ?? 0)} label={t("start.metric.capabilities")} tone="ok" />
      <Metric value={report?.checks.filter(c => c.status === "warn").length.toString() ?? "0"} label={t("start.metric.risk")} tone={warn ? "warn" : "ok"} />
      <Metric value={caps?.runtime_state?.state ? formatTargetState(String(caps.runtime_state.state), t) : "-"} label={t("start.metric.runtimeState")} tone="blue" />
    </div>
  );
}

function Metric({ value, label, tone }: { value: string; label: string; tone: "ok" | "warn" | "bad" | "blue" }) {
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--amber)" : tone === "bad" ? "var(--red)" : "var(--blue)";
  return (
    <div style={{ padding: "10px 8px", borderRight: "1px solid var(--border)", background: "#fbfbf9" }}>
      <span style={{ display: "block", color, fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700 }}>{value}</span>
      <span style={{ display: "block", marginTop: 2, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{label}</span>
    </div>
  );
}

function PreflightTimeline({ report, checking, t }: { report: PreflightReport | null; checking: boolean; t: TFunction }) {
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 1, background: "var(--border-light)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {checking && <TimelineRow code="-" text={t("start.preflight.checking")} status="checking" t={t} />}
      {!checking && !report && <TimelineRow code="-" text={t("start.preflight.waiting")} status="idle" t={t} />}
      {!checking && report?.checks.map(check => <TimelineRow key={check.name} code={formatCheckName(check.name, t)} text={formatPreflightMessage(check, t)} status={check.status} t={t} />)}
    </div>
  );
}

function formatCheckName(name: string, t: TFunction): string {
  if (name === "target") return t("result.metricTarget");
  if (name === "artifact") return t("result.metricArtifact");
  if (name === "capabilities") return t("start.capabilities");
  if (name === "safety") return t("settings.system");
  return name;
}

function OptionBlock({ title, status, children }: { title: string; status?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 10, background: "#fbfbf9" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, fontWeight: 700 }}>
        <span>{title}</span>
        {status && <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{status}</span>}
      </div>
      {children}
    </div>
  );
}

function TimelineRow({ code, text, status, t }: { code: string; text: string; status: string; t: TFunction }) {
  const color = status === "ok" || status === "enabled" ? "var(--green)" : status === "warn" ? "var(--amber)" : status === "error" ? "var(--red)" : "var(--fg-tertiary)";
  return (
    <div style={{ background: "var(--bg-card)", padding: "8px 10px", display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 8, alignItems: "center", fontSize: 11 }}>
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-tertiary)", fontSize: 10 }}>{code}</span>
      <span>{text}</span>
      <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10 }}>{formatStatusLabel(status, t)}</span>
    </div>
  );
}
