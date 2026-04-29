import { copyFile, rename, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

type RenameFile = typeof rename;
type CopyFile = typeof copyFile;
type RemoveFile = typeof rm;
type Sleep = (milliseconds: number) => Promise<void>;

export type ReplaceFileOptions = {
  platform?: NodeJS.Platform;
  renameFile?: RenameFile;
  copyFile?: CopyFile;
  removeFile?: RemoveFile;
  sleep?: Sleep;
  destinationExists?: (filePath: string) => Promise<boolean>;
  retryDelaysMs?: number[];
};

const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000];

export async function replaceFile(tempPath: string, filePath: string, options: ReplaceFileOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const copy = options.copyFile ?? copyFile;
  const remove = options.removeFile ?? rm;
  const wait = options.sleep ?? sleep;
  const destinationExists = options.destinationExists ?? fileExists;
  const retryDelaysMs = options.retryDelaysMs ?? WINDOWS_REPLACE_RETRY_DELAYS_MS;

  try {
    await runWithWindowsRetry(() => renameFile(tempPath, filePath), {
      platform,
      sleep: wait,
      retryDelaysMs
    });
    return;
  } catch (error) {
    if (!(platform === "win32" && isWindowsReplaceError(error) && (await destinationExists(filePath)))) {
      throw error;
    }
  }

  // Windows fallback trades POSIX-style atomicity for best-effort recovery when
  // replace-by-rename is blocked by transient destination locks.
  await runWithWindowsRetry(() => copy(tempPath, filePath), {
    platform,
    sleep: wait,
    retryDelaysMs
  });
  try {
    await remove(tempPath, { force: true });
  } catch {
    // The destination has already been updated; temp cleanup must not turn a
    // successful write into a failed run mutation.
  }
}

async function runWithWindowsRetry(
  operation: () => Promise<void>,
  options: {
    platform: NodeJS.Platform;
    sleep: Sleep;
    retryDelaysMs: number[];
  }
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const retryDelayMs = options.retryDelaysMs[attempt];
      if (options.platform !== "win32" || retryDelayMs === undefined || !isWindowsReplaceError(error)) {
        throw error;
      }
      await options.sleep(retryDelayMs);
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isWindowsReplaceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
