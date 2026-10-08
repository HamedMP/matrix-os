/** Bounded, content-free renderer marks for native startup acceptance. */
export function markChatNavigation(stage: "scope-ready" | "request" | "legacy-request" | "identity-request" | "cache-ready" | "snapshot-ready", rows?: number) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }
  const name = `matrix.chat.navigation.${stage}`;
  if (performance.getEntriesByName(name).length >= 32) {
    performance.clearMarks(name);
  }
  performance.mark(name, { detail: rows === undefined ? undefined : { rows } });
}
