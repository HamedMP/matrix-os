import type { AgentProviderSummary, SafeSetupAction } from "@matrix-os/contracts";

// CLI-owned credential management stays visible in the owner terminal. Pi's
// logout is a TUI command, not a CLI argument (pi /logout would send a prompt).
const LOGOUT_COMMANDS: Partial<Record<AgentProviderSummary["kind"], string>> = {
  claude: "claude auth logout",
  codex: "codex logout",
  opencode: "opencode auth logout",
  pi: 'printf "%s\\n" "In Pi, type /logout and choose the account to disconnect." "Press Enter to open Pi."; read -r reply; pi',
};

export function providerAuthActions(summary: AgentProviderSummary): SafeSetupAction[] {
  if (summary.installStatus !== "installed") return summary.setupActions;
  const actions = summary.setupActions.filter((action) => !action.id.endsWith("_install"));
  const logout = LOGOUT_COMMANDS[summary.kind];
  const locallyConfiguredCodex = summary.kind === "codex" && summary.availability === "available"
    && summary.authStatus === "unknown";
  if ((summary.authStatus !== "authenticated" && !locallyConfiguredCodex)
    || !logout || !actions.some((action) => action.kind === "foreground_terminal")) return actions;
  const command = [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    logout,
  ].join("; ");
  return [{
    id: `${summary.id}_disconnect`,
    kind: "foreground_terminal",
    label: `Disconnect ${summary.displayName}`,
    command,
  }];
}
