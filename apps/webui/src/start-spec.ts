import type { ValidationSpec } from "./api";

export type ArtifactSource = "path" | "latest" | "watch";
export type ArtifactType = "firmware" | "ota" | "apk" | "package" | "file";
export type DeploymentMode = "observe" | "flash" | "replace" | "install";
export type ReplyLanguage = "zh" | "en";
export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

export type IntentDraft = {
  artifactSource: ArtifactSource;
  artifactPath: string;
  latestBuild: string;
  watchPattern: string;
  deploymentMode: DeploymentMode;
  artifactType: ArtifactType;
  flashTool: string;
  flashPartition: string;
  target: string;
  expected: string;
  whatChanged: string;
  replacePath: string;
};

export function artifactPathForSource(source: ArtifactSource, artifactPath: string, latestBuild: string, watchPattern: string): string {
  if (source === "latest") return latestBuild;
  if (source === "watch") return watchPattern;
  return artifactPath;
}

export function inferArtifactType(path: string, deploymentMode: DeploymentMode): ArtifactType {
  const normalized = path.split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (deploymentMode === "install") return normalized.endsWith(".apk") ? "apk" : "package";
  if (deploymentMode === "flash") return isOtaPath(normalized) ? "ota" : "firmware";
  if (normalized.endsWith(".apk")) return "apk";
  if (isFirmwarePath(normalized)) return "firmware";
  if (isOtaPath(normalized)) return "ota";
  if (isPackagePath(normalized)) return "package";
  return "file";
}

export function defaultReplacePath(path: string): string {
  const name = fileNameFromPath(path);
  return `/data/local/tmp/${name || "test-content"}`;
}

export function inferIntentDraft(text: string, current: IntentDraft): IntentDraft {
  const trimmed = text.trim();
  const paths = pathLikes(trimmed);
  const path = paths[0] ?? null;
  const replaceDestination = paths[1] ?? null;
  const target = firstTargetLike(trimmed);
  const artifactSource = path ? (path.startsWith("ci://") ? "latest" : path.includes("*") ? "watch" : "path") : current.artifactSource;
  const nextPath = path ?? artifactPathForSource(current.artifactSource, current.artifactPath, current.latestBuild, current.watchPattern);
  return {
    ...current,
    artifactSource,
    artifactPath: artifactSource === "path" ? nextPath : current.artifactPath,
    latestBuild: artifactSource === "latest" ? nextPath : current.latestBuild,
    watchPattern: artifactSource === "watch" ? nextPath : current.watchPattern,
    deploymentMode: current.deploymentMode,
    artifactType: current.artifactType,
    flashTool: current.flashTool,
    flashPartition: current.flashPartition,
    target: target ?? current.target,
    expected: inferExpectedFromText(trimmed, current.expected),
    whatChanged: trimmed || current.whatChanged,
    replacePath: replaceDestination ?? current.replacePath,
  };
}

export function deploymentModeLabel(mode: DeploymentMode, t: TFunction): string {
  return t(`start.deployment.${mode}`);
}

export function deploymentModeHint(mode: DeploymentMode, t: TFunction): string {
  return t(`start.deployment.${mode}Hint`);
}

export function deploymentRequiresArtifact(mode: DeploymentMode): boolean {
  return mode !== "observe";
}

export function formatArtifactType(type: string, t: TFunction): string {
  const translated = t(`start.contentType.${type}`);
  return translated.startsWith("start.contentType.") ? type : translated;
}

export function buildSpec(input: {
  artifactSource: ArtifactSource;
  artifactPath: string;
  latestBuild: string;
  watchPattern: string;
  deploymentMode: DeploymentMode;
  artifactType: ArtifactType;
  replacePath: string;
  flashTool: string;
  flashPartition: string;
  target: string;
  expected: string;
  whatChanged: string;
  maxDur: number;
  allowShell: boolean;
  successCriteria: string;
  failureCriteria: string;
  replyLanguage: ReplyLanguage;
  t: TFunction;
}): ValidationSpec {
  const path = artifactPathForSource(input.artifactSource, input.artifactPath, input.latestBuild, input.watchPattern);
  const artifactPath = deploymentRequiresArtifact(input.deploymentMode) ? path : "";
  const type = input.artifactType;
  const allowFlash = input.deploymentMode === "flash";
  const spec: ValidationSpec = {
    artifact: { path: artifactPath, type },
    target: input.target,
    expected: input.expected,
    deployment_mode: input.deploymentMode,
    task: buildTaskDescription(input.deploymentMode, type, input.t),
    reply_language: input.replyLanguage,
    constraints: {
      max_duration_sec: input.maxDur,
      allow_flash: allowFlash,
      allow_shell_exec: input.allowShell,
      no_flash: !allowFlash,
    },
  };

  const concerns: string[] = [];
  const changed = input.whatChanged.trim();
  if (changed) concerns.push(`${input.t("start.concern.whatChanged")}: ${changed}`);
  concerns.push(`${input.t("start.concern.deployment")}: ${deploymentModeLabel(input.deploymentMode, input.t)}`);
  concerns.push(`${input.t("start.concern.contentType")}: ${formatArtifactType(type, input.t)}`);
  if (input.deploymentMode === "replace" || input.deploymentMode === "flash" || input.deploymentMode === "install") {
    concerns.push(`${input.t("start.concern.sourcePath")}: ${path}`);
  }
  if (input.deploymentMode === "replace" && input.replacePath.trim()) {
    concerns.push(`${input.t("start.concern.replacePath")}: ${input.replacePath.trim()}`);
  }
  if (input.deploymentMode === "flash") {
    if (input.flashTool.trim()) concerns.push(`${input.t("start.concern.flashTool")}: ${input.flashTool.trim()}`);
    if (input.flashPartition.trim()) concerns.push(`${input.t("start.concern.flashPartition")}: ${input.flashPartition.trim()}`);
  }
  if (input.deploymentMode === "observe") concerns.push(input.t("start.concern.observeOnly"));
  spec.concerns = concerns;

  const success = lines(input.successCriteria);
  const failure = lines(input.failureCriteria);
  if (success.length) spec.success_criteria = success;
  if (failure.length) spec.failure_criteria = failure;
  return spec;
}

function buildTaskDescription(mode: DeploymentMode, type: string, t: TFunction): string {
  return t(`start.task.${mode}`, { type: formatArtifactType(type, t) });
}

function fileNameFromPath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? "";
  const normalized = clean.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? "";
}

function pathLikes(text: string): string[] {
  return Array.from(text.matchAll(/(?:ci:\/\/|\/|\.\/|~\/|[A-Za-z]:\\)[^\s，,；;]+/g), match => match[0]);
}

function firstTargetLike(text: string): string | null {
  const match = text.match(/\b(?:[a-z][a-z0-9_-]*(?:board|lab|device|dut|s820|rk3588)[a-z0-9_-]*|s820-\d+|rk3588-lab|board-\d+)\b/i);
  return match?.[0] ?? null;
}

function inferExpectedFromText(text: string, fallback: string): string {
  if (!text.trim()) return fallback;
  const clauses = text.split(/[，,；;]/).map(item => item.trim()).filter(Boolean);
  const expectation = clauses.find(item => /确认|没有|无|正常|启动|响应|进入|crash|panic|expect|verify/i.test(item));
  return expectation ?? fallback;
}

function isFirmwarePath(path: string): boolean {
  return /\.(img|bin|hex|elf|uf2|fw|mbn)$/.test(path);
}

function isOtaPath(path: string): boolean {
  return /\.(ota|zip)$/.test(path);
}

function isPackagePath(path: string): boolean {
  return /\.(deb|ipk|rpm|tar|tgz|tar\.gz)$/.test(path);
}

function lines(value: string): string[] {
  return value.split("\n").map(item => item.trim()).filter(Boolean);
}
