const HINTS: Record<string, string> = {
  session_not_found: "Session not found. Create one with `mos shell new <name>`.",
  session_exists: "Session already exists. Reattach with `mos shell attach <name>`.",
  invalid_layout: "Layout is invalid. Inspect it with `mos shell layout show <name>` before applying it.",
  timeout: "The request timed out. Check `mos doctor` and retry.",
  request_timeout: "The request timed out. Check `mos doctor` and retry.",
  attach_failed: "Terminal attach failed. Reattach with `mos shell attach <name>`.",
  zellij_failed: "Shell backend unavailable. Run `mos doctor --profile cloud`.",
  gateway_unreachable: "Gateway unreachable. Start local dev services or run `mos profile use cloud`.",
  platform_unreachable: "Platform unreachable. Start local platform services, run `mos login --dev`, or run `mos profile use cloud`.",
  auth_expired: "Auth expired. Run `mos login` to refresh this profile.",
  unsupported_version: "Daemon protocol is incompatible. Please update the Matrix CLI and restart the daemon.",
  unknown_command: "Daemon command is not supported. Please update the Matrix CLI and daemon together.",
};

export function recoveryHintForCode(code: string): string {
  return HINTS[code] ?? "Run `mos doctor` for recovery guidance.";
}
