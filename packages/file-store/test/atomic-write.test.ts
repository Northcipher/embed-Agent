import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceFile } from "../src/atomic-write.js";

describe("replaceFile", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-atomic-write-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("retries transient Windows EPERM rename failures without losing the target file", async () => {
    const targetPath = path.join(rootDir, "run.json");
    const tempPath = path.join(rootDir, ".run.json.tmp");
    await writeFile(targetPath, "old\n");
    await writeFile(tempPath, "new\n");

    let attempts = 0;
    await replaceFile(tempPath, targetPath, {
      platform: "win32",
      retryDelaysMs: [1, 1, 1],
      sleep: async () => undefined,
      renameFile: async (from, to) => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("file is locked"), { code: "EPERM" });
        }
        await rename(from, to);
      }
    });

    expect(attempts).toBe(3);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to copy-overwrite on persistent Windows replace lock errors", async () => {
    const targetPath = path.join(rootDir, "run.json");
    const tempPath = path.join(rootDir, ".run.json.tmp");
    await writeFile(targetPath, "old\n");
    await writeFile(tempPath, "new\n");

    await replaceFile(tempPath, targetPath, {
      platform: "win32",
      retryDelaysMs: [1],
      sleep: async () => undefined,
      renameFile: async () => {
        throw Object.assign(new Error("file is locked"), { code: "EPERM" });
      }
    });

    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries transient Windows copy fallback failures", async () => {
    const targetPath = path.join(rootDir, "run.json");
    const tempPath = path.join(rootDir, ".run.json.tmp");
    await writeFile(targetPath, "old\n");
    await writeFile(tempPath, "new\n");

    let copyAttempts = 0;
    await replaceFile(tempPath, targetPath, {
      platform: "win32",
      retryDelaysMs: [1, 1, 1],
      sleep: async () => undefined,
      renameFile: async () => {
        throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
      },
      copyFile: async (from, to) => {
        copyAttempts += 1;
        if (copyAttempts < 3) {
          throw Object.assign(new Error("copy blocked"), { code: "EBUSY" });
        }
        await writeFile(to, await readFile(from));
      }
    });

    expect(copyAttempts).toBe(3);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
  });

  it("does not fail a completed fallback write when temp cleanup fails", async () => {
    const targetPath = path.join(rootDir, "run.json");
    const tempPath = path.join(rootDir, ".run.json.tmp");
    await writeFile(targetPath, "old\n");
    await writeFile(tempPath, "new\n");

    await expect(
      replaceFile(tempPath, targetPath, {
        platform: "win32",
        retryDelaysMs: [1],
        sleep: async () => undefined,
        renameFile: async () => {
          throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
        },
        removeFile: async () => {
          throw Object.assign(new Error("cleanup blocked"), { code: "EPERM" });
        }
      })
    ).resolves.toBeUndefined();

    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
    await expect(readFile(tempPath, "utf8")).resolves.toBe("new\n");
  });

  it("does not retry or fall back on non-Windows replace errors", async () => {
    const targetPath = path.join(rootDir, "run.json");
    const tempPath = path.join(rootDir, ".run.json.tmp");
    await writeFile(targetPath, "old\n");
    await writeFile(tempPath, "new\n");
    let copyAttempts = 0;

    await expect(
      replaceFile(tempPath, targetPath, {
        platform: "linux",
        retryDelaysMs: [1, 1],
        sleep: async () => undefined,
        renameFile: async () => {
          throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
        },
        copyFile: async () => {
          copyAttempts += 1;
        }
      })
    ).rejects.toMatchObject({ code: "EPERM" });

    expect(copyAttempts).toBe(0);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("old\n");
  });
});
