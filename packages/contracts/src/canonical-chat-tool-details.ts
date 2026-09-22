/** Shared desktop/web/mobile projection; keep metadata and output visible together. */
export function canonicalChatToolDetail(
  metadata: string | undefined,
  output: readonly string[] | undefined,
): string | undefined {
  const maxChars = 16_000;
  let detail = metadata ?? "";
  for (const chunk of output ?? []) {
    const next = `${detail ? "\n\n" : ""}${chunk}`;
    if (detail.length + next.length > maxChars) {
      const marker = "\nOutput was truncated for display.";
      return `${(detail + next).slice(0, maxChars - marker.length)}${marker}`;
    }
    detail += next;
  }
  return detail || undefined;
}
