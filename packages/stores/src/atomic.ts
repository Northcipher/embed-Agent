import fs from "node:fs/promises";
import path from "node:path";

let writeSeq = 0;

export async function writeAtomic(filePath: string, data: string): Promise<void> {
  // Unique temp name per write — avoids races when concurrent writes target the same file
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${writeSeq++}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, data, "utf-8");
  await fs.rename(tmp, filePath);
}
