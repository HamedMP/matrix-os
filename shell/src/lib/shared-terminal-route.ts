const SHARED_TERMINAL_PATH_PREFIX = "__terminal__:shared:";

export function sharedTerminalAppPath(scopeId: string): string {
  return `${SHARED_TERMINAL_PATH_PREFIX}${encodeURIComponent(scopeId)}`;
}

export function sharedTerminalScopeIdFromPath(path: string): string | null {
  if (!path.startsWith(SHARED_TERMINAL_PATH_PREFIX)) return null;
  const encoded = path.slice(SHARED_TERMINAL_PATH_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
