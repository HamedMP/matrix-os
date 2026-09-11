const HINTS: Record<string, string> = {
  session_not_found: "Terminal tab not found. Run `mos shell list` and reconnect by project and tab ID.",
  session_exists: "Terminal tab already exists. Run `mos shell list` to find its stable tab ID.",
  invalid_layout: "Native Zellij layout commands were removed. Use Matrix client-side splits.",
  timeout: "The request timed out. Check `mos doctor` and retry.",
  request_timeout: "The request timed out. Check `mos doctor` and retry.",
  attach_failed: "Terminal attach failed. Run `mos shell list`, then `mos shell connect --project <project> --tab <tab-id>`.",
  attach_timeout: "Terminal attach timed out. Check `mos doctor` and retry.",
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
