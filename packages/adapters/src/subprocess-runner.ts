import { spawn } from "node:child_process";
import type { CommandInvocation, CommandRunner, CommandRunResult } from "./types.js";

export class SpawnCommandRunner implements CommandRunner {
  private readonly maxOutputBytes: number;

  constructor(options: { maxOutputBytes?: number } = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  async run(invocation: CommandInvocation): Promise<CommandRunResult> {
    const startedAt = Date.now();

    return new Promise<CommandRunResult>((resolve, reject) => {
      const child = spawn(invocation.file, invocation.args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let forceKillTimeout: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2000);
      }, Math.max(0, invocation.timeoutSec) * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        const appendResult = appendChunk(stdoutChunks, stdoutBytes, chunk, this.maxOutputBytes);
        stdoutBytes = appendResult.bytes;
        stdoutTruncated ||= appendResult.truncated;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const appendResult = appendChunk(stderrChunks, stderrBytes, chunk, this.maxOutputBytes);
        stderrBytes = appendResult.bytes;
        stderrTruncated ||= appendResult.truncated;
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
          stdoutTruncated,
          stderrTruncated,
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

function appendChunk(chunks: Buffer[], currentBytes: number, chunk: Buffer, maxBytes: number): { bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) {
    return { bytes: currentBytes, truncated: chunk.byteLength > 0 };
  }
  const remainingBytes = maxBytes - currentBytes;
  const nextChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
  chunks.push(nextChunk);
  return {
    bytes: currentBytes + nextChunk.byteLength,
    truncated: chunk.byteLength > remainingBytes
  };
}
