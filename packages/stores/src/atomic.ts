import fs from "node:fs/promises";
import path from "node:path";

export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = filePath + ".tmp";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, data, "utf-8");
  await fs.rename(tmp, filePath);
}
