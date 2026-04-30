export function validateId(id: string, label: string): void {
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid ${label}: "${id}" contains path characters`);
  }
}

export function generateId(prefix = "id"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract JSON from markdown code fences. Returns parsed object or null. */
export function extractJson<T = Record<string, unknown>>(content: string): T | null {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
