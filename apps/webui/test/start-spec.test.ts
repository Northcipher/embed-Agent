import { describe, expect, it } from "vitest";
import { buildSpec, defaultReplacePath, inferArtifactType, inferIntentDraft, type IntentDraft, type TFunction } from "../src/start-spec";

const t: TFunction = (key, vars) => {
  const dict: Record<string, string> = {
    "start.contentType.firmware": "firmware",
    "start.contentType.ota": "ota",
    "start.contentType.apk": "apk",
    "start.contentType.package": "package",
    "start.contentType.file": "file",
    "start.concern.whatChanged": "change",
    "start.concern.deployment": "device flow",
    "start.concern.contentType": "content type",
    "start.concern.sourcePath": "source",
    "start.concern.replacePath": "device path",
    "start.concern.flashTool": "flash tool",
    "start.concern.flashPartition": "flash partition",
    "start.concern.observeOnly": "observe only",
    "start.deployment.observe": "observe",
    "start.deployment.flash": "flash",
    "start.deployment.replace": "replace",
    "start.deployment.install": "install",
    "start.task.observe": "observe {type}",
    "start.task.flash": "flash {type}",
    "start.task.replace": "replace {type}",
    "start.task.install": "install {type}",
  };
  let value = dict[key] ?? key;
  if (vars) for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
};

describe("start spec helpers", () => {
  it("infers the content type from deployment mode and path", () => {
    expect(inferArtifactType("/build/boot.img", "flash")).toBe("firmware");
    expect(inferArtifactType("/build/update.zip", "flash")).toBe("ota");
    expect(inferArtifactType("/build/app.apk", "install")).toBe("apk");
    expect(inferArtifactType("/build/libcamera.so", "replace")).toBe("file");
  });

  it("derives a default device path for replacement validation", () => {
    expect(defaultReplacePath("/builds/libfoo.so")).toBe("/data/local/tmp/libfoo.so");
    expect(defaultReplacePath(String.raw`C:\builds\libfoo.so`)).toBe("/data/local/tmp/libfoo.so");
    expect(defaultReplacePath("ci://nightly/app.apk?build=42")).toBe("/data/local/tmp/app.apk");
  });

  it("turns the device flow into constraints and planner context", () => {
    const spec = buildSpec({
      artifactSource: "path",
      artifactPath: "/builds/libfoo.so",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "replace",
      artifactType: "package",
      replacePath: "/vendor/lib64/libfoo.so",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "board-1",
      expected: "service starts",
      whatChanged: "new shared library",
      maxDur: 120,
      allowShell: true,
      successCriteria: "service active",
      failureCriteria: "crash loop",
      replyLanguage: "en",
      t,
    });

    expect(spec.artifact).toEqual({ path: "/builds/libfoo.so", type: "package" });
    expect(spec.constraints).toEqual({ max_duration_sec: 120, allow_flash: false, allow_shell_exec: true, no_flash: true });
    expect(spec.task).toBe("replace package");
    expect(spec.concerns).toEqual([
      "change: new shared library",
      "device flow: replace",
      "content type: package",
      "source: /builds/libfoo.so",
      "device path: /vendor/lib64/libfoo.so",
    ]);
    expect(spec.success_criteria).toEqual(["service active"]);
    expect(spec.failure_criteria).toEqual(["crash loop"]);
  });

  it("adds flash tool and partition details to planner context", () => {
    const spec = buildSpec({
      artifactSource: "path",
      artifactPath: "/builds/boot.img",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "flash",
      artifactType: "firmware",
      replacePath: "/data/local/tmp/boot.img",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "board-1",
      expected: "device boots",
      whatChanged: "new boot image",
      maxDur: 180,
      allowShell: true,
      successCriteria: "",
      failureCriteria: "",
      replyLanguage: "en",
      t,
    });

    expect(spec.concerns).toEqual([
      "change: new boot image",
      "device flow: flash",
      "content type: firmware",
      "source: /builds/boot.img",
      "flash tool: fastboot",
      "flash partition: boot",
    ]);
  });

  it("omits the artifact path for observe mode while keeping deployment mode", () => {
    const spec = buildSpec({
      artifactSource: "path",
      artifactPath: "/builds/boot.img",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "observe",
      artifactType: "firmware",
      replacePath: "/data/local/tmp/boot.img",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "board-1",
      expected: "device stays healthy",
      whatChanged: "manual flash already done",
      maxDur: 180,
      allowShell: true,
      successCriteria: "",
      failureCriteria: "",
      replyLanguage: "en",
      t,
    });

    expect(spec.artifact).toEqual({ path: "", type: "firmware" });
    expect(spec.deployment_mode).toBe("observe");
    expect(spec.concerns).toEqual([
      "change: manual flash already done",
      "device flow: observe",
      "content type: firmware",
      "observe only",
    ]);
  });

  it("infers a runnable draft from a single engineer sentence", () => {
    const current: IntentDraft = {
      artifactSource: "path",
      artifactPath: "/old/boot.img",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "observe",
      artifactType: "firmware",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "",
      expected: "device works",
      whatChanged: "",
      replacePath: "",
    };

    const draft = inferIntentDraft("刷 /builds/s820/nightly/boot.img 到 s820-01，确认 120 秒内能启动并进入 adb", current);

    expect(draft.artifactSource).toBe("path");
    expect(draft.artifactPath).toBe("/builds/s820/nightly/boot.img");
    expect(draft.deploymentMode).toBe("observe");
    expect(draft.artifactType).toBe("firmware");
    expect(draft.target).toBe("s820-01");
    expect(draft.expected).toBe("确认 120 秒内能启动并进入 adb");
  });

  it("infers replacement validation from package-like wording", () => {
    const current: IntentDraft = {
      artifactSource: "path",
      artifactPath: "/old/boot.img",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "observe",
      artifactType: "firmware",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "board-1",
      expected: "device works",
      whatChanged: "",
      replacePath: "",
    };

    const draft = inferIntentDraft("把 /tmp/libcamera.so 推到 rk3588-lab 的 /vendor/lib64/libcamera.so，然后看 camera service 是否正常", current);

    expect(draft.artifactPath).toBe("/tmp/libcamera.so");
    expect(draft.deploymentMode).toBe("observe");
    expect(draft.artifactType).toBe("firmware");
    expect(draft.target).toBe("rk3588-lab");
    expect(draft.replacePath).toBe("/vendor/lib64/libcamera.so");
  });

  it("infers paths from a Windows host sentence", () => {
    const current: IntentDraft = {
      artifactSource: "path",
      artifactPath: String.raw`C:\old\boot.img`,
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "observe",
      artifactType: "firmware",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "",
      expected: "device works",
      whatChanged: "",
      replacePath: "",
    };

    const draft = inferIntentDraft(String.raw`Flash C:\builds\s820\nightly\boot.img to s820-01, verify adb comes online`, current);

    expect(draft.artifactSource).toBe("path");
    expect(draft.artifactPath).toBe(String.raw`C:\builds\s820\nightly\boot.img`);
    expect(draft.deploymentMode).toBe("observe");
    expect(draft.target).toBe("s820-01");
    expect(draft.expected).toBe("verify adb comes online");
  });

  it("keeps the engineer-selected flow and content type when text changes", () => {
    const current: IntentDraft = {
      artifactSource: "path",
      artifactPath: "/old/boot.img",
      latestBuild: "",
      watchPattern: "",
      deploymentMode: "install",
      artifactType: "apk",
      flashTool: "fastboot",
      flashPartition: "boot",
      target: "board-1",
      expected: "device works",
      whatChanged: "",
      replacePath: "",
    };

    const draft = inferIntentDraft("刷 /builds/s820/nightly/boot.img 到 s820-01，确认系统能启动", current);

    expect(draft.deploymentMode).toBe("install");
    expect(draft.artifactType).toBe("apk");
    expect(draft.target).toBe("s820-01");
  });
});
