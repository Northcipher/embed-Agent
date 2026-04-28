import { spawn } from "node:child_process";
export class SpawnCommandRunner {
    maxOutputBytes;
    constructor(options = {}) {
        this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    }
    async run(invocation) {
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            const child = spawn(invocation.file, invocation.args, {
                shell: false,
                stdio: ["pipe", "pipe", "pipe"]
            });
            const stdoutChunks = [];
            const stderrChunks = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let timedOut = false;
            let settled = false;
            let forceKillTimeout;
            const timeout = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                forceKillTimeout = setTimeout(() => {
                    child.kill("SIGKILL");
                }, 2000);
            }, Math.max(0, invocation.timeoutSec) * 1000);
            child.stdout.on("data", (chunk) => {
                stdoutBytes = appendChunk(stdoutChunks, stdoutBytes, chunk, this.maxOutputBytes);
            });
            child.stderr.on("data", (chunk) => {
                stderrBytes = appendChunk(stderrChunks, stderrBytes, chunk, this.maxOutputBytes);
            });
            child.on("error", error => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKillTimeout !== undefined) {
                    clearTimeout(forceKillTimeout);
                }
                reject(error);
            });
            child.on("close", code => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKillTimeout !== undefined) {
                    clearTimeout(forceKillTimeout);
                }
                resolve({
                    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf8"),
                    exitCode: code,
                    timedOut,
                    durationSec: (Date.now() - startedAt) / 1000
                });
            });
            if (invocation.stdin !== undefined) {
                child.stdin.write(invocation.stdin);
            }
            child.stdin.end();
        });
    }
}
function appendChunk(chunks, currentBytes, chunk, maxBytes) {
    if (currentBytes >= maxBytes) {
        return currentBytes;
    }
    const remainingBytes = maxBytes - currentBytes;
    const nextChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
    chunks.push(nextChunk);
    return currentBytes + nextChunk.byteLength;
}
//# sourceMappingURL=subprocess-runner.js.map