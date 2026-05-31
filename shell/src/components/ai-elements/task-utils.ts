import type { TaskData } from "./task";

export function parseTask(content: string): TaskData | null {
  const match = content.match(
    /```task\n([\s\S]*?)```/,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.title === "string" &&
      typeof parsed.status === "string"
    ) {
      return parsed as TaskData;
    }
  } catch (err: unknown) {
    console.warn("[task] Failed to parse task:", err instanceof Error ? err.message : String(err));
  }
  return null;
}
