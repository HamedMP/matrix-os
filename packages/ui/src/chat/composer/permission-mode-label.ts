/** Native names where providers expose different permission semantics. */
export function chatPermissionModeLabel(mode: string, driverKind?: string): string {
  if (mode === "auto_review") return "Approve for me";
  if (driverKind === "codex" && mode === "supervised") return "Ask for approval";
  if (driverKind === "claude_code") {
    if (mode === "supervised") return "Manual";
    if (mode === "auto_accept_edits") return "Accept edits";
    if (mode === "dont_ask") return "Don't ask";
  }
  return mode.split("_").map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`).join(" ");
}
