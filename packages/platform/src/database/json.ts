/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007). */
export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}
