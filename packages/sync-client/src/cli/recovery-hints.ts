const HINTS: Record<string, string> = {
  session_not_found: "Session not found. Create one with `matrix shell new <name>`.",
  session_exists: "Session already exists. Reattach with `matrix shell attach <name>`.",
  invalid_layout: "Layout is invalid. Inspect it with `matrix shell layout show <name>` before applying it.",
  timeout: "The request timed out. Check `matrix doctor` and retry.",
  attach_failed: "Terminal attach failed. reattach with `matrix shell attach <name>`.",
  unsupported_version: "Daemon protocol is incompatible. Please update the Matrix CLI and restart the daemon.",
  unknown_command: "Daemon command is not supported. Please update the Matrix CLI and daemon together.",
};

export function recoveryHintForCode(code: string): string {
  return HINTS[code] ?? "Run `matrix doctor` for recovery guidance.";
}
