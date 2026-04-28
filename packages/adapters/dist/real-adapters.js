import { SerialPort } from "serialport";
import { SpawnCommandRunner } from "./subprocess-runner.js";
export class AdbAdapter {
    capability;
    config;
    runner;
    constructor(capability, config) {
        if (!ADB_CAPABILITIES.includes(capability)) {
            throw new Error(`AdbAdapter cannot provide capability ${capability}`);
        }
        this.capability = capability;
        this.config = config;
        this.runner = config.runner ?? new SpawnCommandRunner();
    }
    async execute(context) {
        assertCapability(context.step, this.capability);
        switch (this.capability) {
            case "push":
                return this.executePush(context);
            case "wait_adb":
                return this.executeWaitAdb(context);
            case "shell_exec":
                return this.executeShellExec(context);
            case "check_process":
                return this.executeCheckProcess(context);
            case "collect_logs":
                return this.executeCollectLogs(context);
            default:
                throw new Error(`Unsupported adb capability ${this.capability}`);
        }
    }
    async executePush(context) {
        const srcRef = requiredString(context.step.input, "src_ref");
        const dstPath = requiredString(context.step.input, "dst_path");
        assertAbsoluteTargetPath(dstPath);
        const command = await this.runAdb(["push", srcRef, dstPath], context.step.timeout_sec);
        const ref = `adb:${context.step.id}`;
        const output = commandOutput(command);
        await writeJsonEvidence(context.store, context.runId, ref, `adb-${safeSegment(context.step.id)}.json`, "command_output", output);
        return result("push", !command.timedOut && command.exitCode === 0, command.timedOut ? "adb push timed out" : "adb push completed", output, [ref]);
    }
    async executeWaitAdb(context) {
        const timeoutSec = numberInput(context.step.input, "timeout_sec", context.step.timeout_sec);
        const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;
        let lastOutput = {
            adb_state: "unknown",
            device_id: this.config.deviceId,
            duration_sec: 0
        };
        do {
            const command = await this.runAdb(["get-state"], Math.max(1, Math.min(timeoutSec || 1, context.step.timeout_sec)));
            const adbState = command.stdout.trim();
            lastOutput = {
                adb_state: adbState || "unknown",
                device_id: this.config.deviceId,
                duration_sec: command.durationSec
            };
            if (!command.timedOut && command.exitCode === 0 && adbState === "device") {
                return result("wait_adb", true, "adb device online", lastOutput, []);
            }
            if (Date.now() >= deadline) {
                break;
            }
            await delay(this.config.waitPollIntervalMs ?? 1000);
        } while (Date.now() <= deadline);
        return {
            capability: "wait_adb",
            success: false,
            status: "timeout",
            output: lastOutput,
            evidence_refs: [],
            summary: "adb wait timed out"
        };
    }
    async executeShellExec(context) {
        const commandText = requiredString(context.step.input, "command");
        assertSafeAdbShellCommand(commandText, this.config.allowShellMetacharacters ?? false);
        const expectedExitCode = numberInput(context.step.input, "expected_exit_code", 0);
        const timeoutSec = numberInput(context.step.input, "timeout_sec", context.step.timeout_sec);
        const command = await this.runAdb(["shell", commandText], timeoutSec);
        const output = commandOutput(command);
        const ref = `adb:${context.step.id}`;
        await writeJsonEvidence(context.store, context.runId, ref, `adb-${safeSegment(context.step.id)}.json`, "command_output", output);
        const success = !command.timedOut && command.exitCode === expectedExitCode;
        return {
            capability: "shell_exec",
            success,
            status: command.timedOut ? "timeout" : success ? "completed" : "failed",
            output,
            evidence_refs: [ref],
            summary: command.timedOut ? "adb shell timed out" : "adb shell completed"
        };
    }
    async executeCheckProcess(context) {
        const processName = requiredString(context.step.input, "process_name");
        const command = await this.runAdb(["shell", "pidof", processName], context.step.timeout_sec);
        const pidText = command.stdout.trim().split(/\s+/).filter(Boolean)[0];
        const exists = !command.timedOut && command.exitCode === 0 && pidText !== undefined;
        return result("check_process", !command.timedOut, exists ? "process found" : "process not found", {
            exists,
            pid: pidText === undefined ? null : Number(pidText),
            state: exists ? "running" : "missing",
            stderr: command.stderr,
            exit_code: command.exitCode
        }, []);
    }
    async executeCollectLogs(context) {
        const items = optionalStringArray(context.step.input, "items");
        const logRefs = [];
        const missingItems = [];
        for (const item of items) {
            if (item === "dmesg") {
                await this.collectLog(context, item, ["shell", "dmesg"], "logs/dmesg.log", logRefs, missingItems);
                continue;
            }
            if (item === "logcat") {
                await this.collectLog(context, item, ["logcat", "-d"], "logs/logcat.log", logRefs, missingItems);
                continue;
            }
            missingItems.push(item);
        }
        return result("collect_logs", true, "adb logs collected", { log_refs: logRefs, missing_items: missingItems }, logRefs);
    }
    async collectLog(context, item, args, evidencePath, logRefs, missingItems) {
        const command = await this.runAdb(args, context.step.timeout_sec);
        if (command.timedOut || command.exitCode !== 0) {
            missingItems.push(item);
            return;
        }
        const ref = `log:${safeSegment(item)}`;
        const content = command.stdout;
        await context.store.addEvidenceRef(context.runId, {
            ref,
            kind: "log",
            path: evidencePath,
            available: true,
            bytes: Buffer.byteLength(content)
        }, content);
        logRefs.push(ref);
    }
    async runAdb(args, timeoutSec) {
        return this.runner.run({
            file: this.config.adbPath ?? "adb",
            args: ["-s", this.config.deviceId, ...args],
            timeoutSec
        });
    }
}
export class FlashAdapter {
    config;
    capability = "flash";
    runner;
    constructor(config) {
        this.config = config;
        this.runner = config.runner ?? new SpawnCommandRunner();
    }
    async execute(context) {
        assertCapability(context.step, this.capability);
        const artifactRef = requiredString(context.step.input, "artifact_ref");
        const artifactType = requiredString(context.step.input, "artifact_type");
        assertResolvedArtifactRef(artifactRef);
        if (this.config.artifactType !== undefined && artifactType !== this.config.artifactType) {
            throw new Error(`artifact_type ${artifactType} does not match flash config artifactType ${this.config.artifactType}`);
        }
        const invocation = this.config.method === "fastboot"
            ? {
                file: this.config.fastbootPath ?? "fastboot",
                args: [
                    ...(this.config.deviceId === undefined ? [] : ["-s", this.config.deviceId]),
                    "flash",
                    this.config.partition,
                    artifactRef
                ],
                timeoutSec: context.step.timeout_sec
            }
            : {
                file: this.config.command.file,
                args: this.config.command.args.map(arg => replaceFlashPlaceholders(arg, artifactRef, artifactType)),
                timeoutSec: context.step.timeout_sec
            };
        assertConfiguredExecutableFile(invocation.file, { allowBareName: this.config.method === "fastboot" });
        const command = await this.runner.run(invocation);
        const content = [
            command.stdout,
            command.stderr.length === 0 ? "" : `\n[stderr]\n${command.stderr}`
        ].join("");
        const ref = "flash:log";
        await context.store.addEvidenceRef(context.runId, {
            ref,
            kind: "log",
            path: "flash.log",
            available: true,
            bytes: Buffer.byteLength(content)
        }, content);
        const success = !command.timedOut && command.exitCode === 0;
        return {
            capability: "flash",
            success,
            status: command.timedOut ? "timeout" : success ? "completed" : "failed",
            output: {
                flash_log_ref: ref,
                success,
                duration_sec: command.durationSec,
                exit_code: command.exitCode
            },
            evidence_refs: [ref],
            summary: command.timedOut ? "flash timed out" : success ? "flash completed" : "flash failed"
        };
    }
}
export class SerialAdapter {
    config;
    capability = "watch_serial";
    reader;
    constructor(config) {
        this.config = config;
        this.reader = config.reader ?? new SerialPortReader();
    }
    async execute(context) {
        assertCapability(context.step, this.capability);
        const durationSec = numberInput(context.step.input, "duration_sec", context.step.timeout_sec);
        const patterns = optionalStringArray(context.step.input, "patterns");
        const readResult = await this.reader.read({
            port: this.config.port,
            baudRate: this.config.baudRate,
            durationSec
        });
        const content = readResult.content.endsWith("\n") ? readResult.content : `${readResult.content}\n`;
        const patternsMatched = patterns.filter(pattern => content.includes(pattern));
        const ref = "serial:full";
        await context.store.addEvidenceRef(context.runId, {
            ref,
            kind: "log",
            path: "serial.log",
            available: true,
            bytes: Buffer.byteLength(content)
        }, content);
        return {
            capability: "watch_serial",
            success: !readResult.disconnected,
            status: readResult.disconnected ? "failed" : "completed",
            output: {
                log_ref: ref,
                patterns_matched: patternsMatched,
                disconnected: readResult.disconnected,
                error: readResult.error ?? null
            },
            evidence_refs: [ref],
            summary: readResult.error !== undefined ? "serial read error" : readResult.disconnected ? "serial disconnected" : "serial watch completed"
        };
    }
}
export class SerialPortReader {
    async read(options) {
        const port = new SerialPort({
            path: options.port,
            baudRate: options.baudRate,
            autoOpen: false
        });
        const chunks = [];
        let disconnected = false;
        let closing = false;
        let serialError;
        port.on("error", error => {
            disconnected = true;
            serialError = error instanceof Error ? error.message : String(error);
        });
        await new Promise((resolve, reject) => {
            port.open(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        port.on("data", (chunk) => {
            chunks.push(chunk);
        });
        port.on("close", () => {
            if (!closing) {
                disconnected = true;
            }
        });
        await delay(Math.max(0, options.durationSec) * 1000);
        if (port.isOpen) {
            closing = true;
            await new Promise((resolve, reject) => {
                port.close(error => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        const result = {
            content: Buffer.concat(chunks).toString("utf8"),
            disconnected
        };
        if (serialError !== undefined) {
            result.error = serialError;
        }
        return result;
    }
}
export class RealAdapterRegistry {
    adapters = new Map();
    constructor(config) {
        if (config.flash !== undefined) {
            this.adapters.set("flash", new FlashAdapter(config.flash));
        }
        if (config.serial !== undefined) {
            this.adapters.set("watch_serial", new SerialAdapter(config.serial));
        }
        if (config.adb !== undefined) {
            for (const capability of ADB_CAPABILITIES) {
                this.adapters.set(capability, new AdbAdapter(capability, config.adb));
            }
        }
    }
    get(capability) {
        return this.adapters.get(capability);
    }
}
const ADB_CAPABILITIES = ["push", "wait_adb", "shell_exec", "check_process", "collect_logs"];
function assertCapability(step, capability) {
    if (step.capability !== capability) {
        throw new Error(`Adapter ${capability} cannot execute step capability ${step.capability}`);
    }
}
function result(capability, success, summary, output, evidenceRefs) {
    return {
        capability,
        success,
        status: success ? "completed" : "failed",
        output,
        evidence_refs: evidenceRefs,
        summary
    };
}
function commandOutput(command) {
    return {
        stdout: command.stdout,
        stderr: command.stderr,
        exit_code: command.exitCode,
        timed_out: command.timedOut,
        stdout_truncated: "stdoutTruncated" in command ? command.stdoutTruncated : false,
        stderr_truncated: "stderrTruncated" in command ? command.stderrTruncated : false,
        duration_sec: command.durationSec
    };
}
function requiredString(input, key) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`step input ${key} must be a non-empty string`);
    }
    return value;
}
function numberInput(input, key, defaultValue) {
    const value = input[key];
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "number") {
        throw new Error(`step input ${key} must be a number`);
    }
    return value;
}
function optionalStringArray(input, key) {
    const value = input[key];
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
        throw new Error(`step input ${key} must be an array of strings`);
    }
    return value;
}
function safeSegment(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
        throw new Error(`value ${value} is not safe for an evidence path segment`);
    }
    return value;
}
function assertAbsoluteTargetPath(value) {
    if (!value.startsWith("/") || value.includes("\0")) {
        throw new Error("dst_path must be an absolute target path");
    }
}
function assertConfiguredExecutableFile(value, options) {
    if (value.length === 0 || value.includes("\0")) {
        throw new Error("executable file must be non-empty");
    }
    if (value.includes("/")) {
        if (!value.startsWith("/") || value.split("/").includes("..") || value.startsWith("/proc/") || value.startsWith("/dev/fd/")) {
            throw new Error("configured executable file must be a safe absolute path or safe binary name");
        }
        return;
    }
    if (!options.allowBareName || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error("configured executable file must be a safe absolute path");
    }
}
function assertResolvedArtifactRef(value) {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
        throw new Error("artifact_ref contains invalid control characters");
    }
    if (value.includes("/") && !value.startsWith("/")) {
        throw new Error("artifact_ref must be an absolute path or safe artifact reference");
    }
    if (value.split("/").includes("..")) {
        throw new Error("artifact_ref must not contain path traversal segments");
    }
}
function assertSafeAdbShellCommand(value, allowShellMetacharacters) {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
        throw new Error("shell_exec command contains invalid control characters");
    }
    if (!allowShellMetacharacters && /[;&|`$<>()\\*?]/.test(value)) {
        throw new Error("shell_exec command contains shell metacharacters; enable allowShellMetacharacters only for trusted target commands");
    }
}
function replaceFlashPlaceholders(value, artifactRef, artifactType) {
    return value.replaceAll("{artifact_ref}", artifactRef).replaceAll("{artifact_type}", artifactType);
}
async function writeJsonEvidence(store, runId, ref, evidencePath, kind, value) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await store.addEvidenceRef(runId, {
        ref,
        kind,
        path: evidencePath,
        available: true,
        bytes: Buffer.byteLength(content)
    }, content);
}
function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
//# sourceMappingURL=real-adapters.js.map