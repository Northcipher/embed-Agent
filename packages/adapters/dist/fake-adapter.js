export class FakeCapabilityAdapter {
    capability;
    script;
    constructor(capability, script = {}) {
        this.capability = capability;
        this.script = script;
    }
    async execute(context) {
        assertCapability(context.step, this.capability);
        switch (this.capability) {
            case "flash":
                return this.executeFlash(context);
            case "push":
                return this.executePush(context);
            case "watch_serial":
                return this.executeWatchSerial(context);
            case "wait_adb":
                return this.executeWaitAdb(context);
            case "shell_exec":
                return this.executeShellExec(context);
            case "check_process":
                return this.executeCheckProcess(context);
            case "collect_logs":
                return this.executeCollectLogs(context);
            case "save_snapshot":
                return this.executeSaveSnapshot(context);
        }
        throw new Error(`Unsupported fake capability ${this.capability}`);
    }
    async executeFlash(context) {
        const success = this.script.flashSucceeds ?? true;
        const ref = "flash:log";
        await context.store.addEvidenceRef(context.runId, {
            ref,
            kind: "log",
            path: "flash.log",
            available: true
        }, success ? "fake flash completed\n" : "fake flash failed\n");
        return result("flash", success, success ? "fake flash completed" : "fake flash failed", { flash_log_ref: ref, success }, [ref]);
    }
    async executePush(context) {
        const ref = `adb:${context.step.id}`;
        const output = {
            stdout: `pushed ${requiredString(context.step.input, "src_ref")} to ${requiredString(context.step.input, "dst_path")}`,
            stderr: "",
            exit_code: 0
        };
        await writeJsonEvidence(context.store, context.runId, ref, `adb-${safeSegment(context.step.id)}.json`, "command_output", output);
        return result("push", true, "fake push completed", { stdout_ref: ref, stderr_ref: ref, exit_code: 0 }, [ref]);
    }
    async executeWatchSerial(context) {
        const patterns = optionalStringArray(context.step.input, "patterns");
        const lines = this.script.serialOutput ?? ["Booting Linux", "init started", "boot completed"];
        const content = `${lines.join("\n")}\n`;
        const patternsMatched = patterns.filter(pattern => content.includes(pattern));
        const ref = "serial:full";
        await context.store.addEvidenceRef(context.runId, {
            ref,
            kind: "log",
            path: "serial.log",
            available: true,
            bytes: Buffer.byteLength(content)
        }, content);
        return result("watch_serial", true, "fake serial watch completed", { log_ref: ref, events: [], patterns_matched: patternsMatched }, [ref]);
    }
    async executeWaitAdb(context) {
        const online = this.script.adbOnline ?? true;
        return result("wait_adb", online, online ? "fake adb online" : "fake adb offline", {
            adb_state: online ? "online" : "offline",
            device_id: "fake-adb",
            duration_sec: numberInput(context.step.input, "timeout_sec", 0)
        }, []);
    }
    async executeShellExec(context) {
        const command = requiredString(context.step.input, "command");
        const expectedExit = numberInput(context.step.input, "expected_exit_code", 0);
        const commandResult = this.script.commandResults?.[command] ?? { exit_code: 0, stdout: "ok\n", stderr: "" };
        const output = {
            stdout: commandResult.stdout ?? "",
            stderr: commandResult.stderr ?? "",
            exit_code: commandResult.exit_code,
            duration_sec: 0
        };
        const ref = `adb:${context.step.id}`;
        await writeJsonEvidence(context.store, context.runId, ref, `adb-${safeSegment(context.step.id)}.json`, "command_output", output);
        return result("shell_exec", commandResult.exit_code === expectedExit, "fake shell_exec completed", output, [ref]);
    }
    async executeCheckProcess(context) {
        const processName = requiredString(context.step.input, "process_name");
        const processInfo = this.script.processes?.[processName];
        return result("check_process", true, processInfo === undefined ? "fake process not found" : "fake process found", {
            exists: processInfo !== undefined,
            pid: processInfo?.pid ?? null,
            state: processInfo?.state ?? "missing"
        }, []);
    }
    async executeCollectLogs(context) {
        const items = optionalStringArray(context.step.input, "items");
        const logRefs = [];
        const missingItems = [];
        for (const item of items) {
            const safeItem = safeSegment(item);
            const content = this.script.logs?.[item];
            if (content === undefined) {
                missingItems.push(item);
                continue;
            }
            const ref = `log:${item}`;
            await context.store.addEvidenceRef(context.runId, {
                ref,
                kind: "log",
                path: `logs/${safeItem}.log`,
                available: true,
                bytes: Buffer.byteLength(content)
            }, content);
            logRefs.push(ref);
        }
        return result("collect_logs", true, "fake logs collected", { log_refs: logRefs, missing_items: missingItems }, logRefs);
    }
    async executeSaveSnapshot(context) {
        const reason = requiredString(context.step.input, "reason");
        const include = optionalStringArray(context.step.input, "include");
        const ref = `snapshot:${context.step.id}`;
        const snapshot = {
            reason,
            include,
            generated_by: "fake-adapter"
        };
        await writeJsonEvidence(context.store, context.runId, ref, `snapshots/${safeSegment(context.step.id)}.json`, "snapshot", snapshot);
        return result("save_snapshot", true, "fake snapshot saved", { snapshot_ref: ref, included_refs: include }, [ref]);
    }
}
export class FakeAdapterRegistry {
    adapters;
    constructor(script = {}) {
        this.adapters = new Map(P0_CAPABILITIES.map(capability => [capability, new FakeCapabilityAdapter(capability, script)]));
    }
    get(capability) {
        return this.adapters.get(capability);
    }
}
const P0_CAPABILITIES = [
    "flash",
    "push",
    "watch_serial",
    "wait_adb",
    "shell_exec",
    "check_process",
    "collect_logs",
    "save_snapshot"
];
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
//# sourceMappingURL=fake-adapter.js.map