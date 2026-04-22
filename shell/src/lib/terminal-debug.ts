export function isTerminalDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.localStorage.getItem("matrix-terminal-debug") === "1") {
      return true;
    }
  } catch (_err: unknown) {
    // Ignore storage access failures.
  }

  try {
    return new URLSearchParams(window.location.search).get("terminalDebug") === "1";
  } catch (_err: unknown) {
    return false;
  }
}
