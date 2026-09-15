/** Compact display/automatic titles; the original message remains unchanged. */
export function compactChatTitle(value: string, maxLength = 80): string {
  const title = value.replace(/\s+/gu, " ").trim();
  if (title.length <= maxLength) return title || "New chat";
  // Avoid cutting a surrogate pair before the ellipsis.
  const prefix = title.slice(0, maxLength - 3).replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
  return `${prefix}...`;
}
