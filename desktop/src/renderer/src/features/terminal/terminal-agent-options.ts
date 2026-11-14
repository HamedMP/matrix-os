import { TERMINAL_AGENT_OPTIONS as SHARED_OPTIONS, parseTerminalAgentStatuses as parseStatuses,
  type TerminalAgentId, type TerminalAgentInstallState, type TerminalAgentOption, type TerminalAgentMenuAction } from "@matrix-os/ui/terminal-launch";
export { terminalAgentVisibleInstallCommand, terminalAgentCreateOptions, type TerminalAgentId, type TerminalAgentInstallState, type TerminalAgentOption, type TerminalAgentMenuAction } from "@matrix-os/ui/terminal-launch";
export const TERMINAL_AGENT_OPTIONS: readonly TerminalAgentOption[] = SHARED_OPTIONS.map(option => ({ ...option, logoSrc: `.${option.logoSrc}` }));
export const UNKNOWN_TERMINAL_AGENT_STATUSES = Object.fromEntries(SHARED_OPTIONS.map(option => [option.id, "unknown"])) as Record<TerminalAgentId, TerminalAgentInstallState>;
export function parseTerminalAgentStatuses(value: unknown): Record<TerminalAgentId, TerminalAgentInstallState> {
  return { ...UNKNOWN_TERMINAL_AGENT_STATUSES, ...Object.fromEntries(parseStatuses(value).map(status => [status.id, status.installState])) };
}
export function terminalAgentAction(state: TerminalAgentInstallState, canInstall = true): TerminalAgentMenuAction | null {
  if (state === "unknown" || state === "missing" && !canInstall) return null;
  return state === "missing" ? "install" : "launch";
}
export function terminalAgentLabel(agent: TerminalAgentId): string { return SHARED_OPTIONS.find(option => option.id === agent)?.shortLabel ?? agent; }
