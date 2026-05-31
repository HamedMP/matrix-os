import type { PlanStep } from "./plan";

export function parsePlan(content: string): PlanStep[] | null {
  const match = content.match(
    /```plan\n([\s\S]*?)```/,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (s): s is PlanStep =>
          typeof s === "object" && s !== null && typeof s.title === "string",
      );
    }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[ai-elements] Failed to parse plan:", error);
    }
  }
  return null;
}
