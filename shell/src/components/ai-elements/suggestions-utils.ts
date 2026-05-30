export const DEFAULT_SUGGESTIONS = [
  "What can you do?",
  "Build me an app",
  "Show my files",
];

export function parseSuggestions(content: string): string[] {
  const match = content.match(
    /<!-- suggestions: (.*?) -->/,
  );
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // ignore parse errors
    }
  }
  return [];
}
