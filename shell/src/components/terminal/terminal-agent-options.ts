import { CODEX_VERIFIED_NPM_PACKAGE } from "@matrix-os/contracts";

export type TerminalAgentId = "claude" | "codex" | "opencode" | "pi";
export type TerminalAgentInstallState = "installed" | "missing" | "unknown";
export type TerminalAgentMenuAction = "launch" | "install";

export interface TerminalAgentOption {
  id: TerminalAgentId;
  label: string;
  color: string;
  logoSrc: string;
  shortcut?: string;
  launchCommand?: string;
  installPackage: string;
  installFlags?: string[];
  claudeMode?: boolean;
}

export interface TerminalAgentStatus {
  id: TerminalAgentId;
  installState: TerminalAgentInstallState;
}

export const TERMINAL_AGENT_OPTIONS: TerminalAgentOption[] = [
  {
    id: "claude",
    label: "Claude Code",
    color: "#D8792C",
    logoSrc: "/agent-logos/claude-code.png",
    shortcut: "⌘⇧C",
    installPackage: "@anthropic-ai/claude-code@latest",
    claudeMode: true,
  },
  {
    id: "codex",
    label: "Codex",
    color: "#465243",
    logoSrc: "/agent-logos/codex.png",
    shortcut: "⌘⇧X",
    launchCommand: "codex",
    installPackage: CODEX_VERIFIED_NPM_PACKAGE,
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#111111",
    logoSrc: "/agent-logos/opencode-white.png",
    launchCommand: "opencode",
    installPackage: "opencode-ai@latest",
  },
  {
    id: "pi",
    label: "Pi",
    color: "#1E2F5C",
    logoSrc: "/agent-logos/pi-coding-agent.png",
    launchCommand: "pi",
    installPackage: "@earendil-works/pi-coding-agent@latest",
    installFlags: ["--ignore-scripts"],
  },
];

export function isTerminalAgentId(value: unknown): value is TerminalAgentId {
  return value === "claude" || value === "codex" || value === "opencode" || value === "pi";
}

function isTerminalAgentInstallState(value: unknown): value is TerminalAgentInstallState {
  return value === "installed" || value === "missing" || value === "unknown";
}

export function parseTerminalAgentStatuses(value: unknown): TerminalAgentStatus[] {
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) {
    return [];
  }
  const statuses: TerminalAgentStatus[] = [];
  for (const candidate of value.agents) {
    if (!candidate || typeof candidate !== "object") continue;
    const agent = candidate as { id?: unknown; installState?: unknown; installed?: unknown };
    if (!isTerminalAgentId(agent.id)) continue;
    if (isTerminalAgentInstallState(agent.installState)) {
      statuses.push({ id: agent.id, installState: agent.installState });
    } else if (agent.installed === true) {
      statuses.push({ id: agent.id, installState: "installed" });
    } else if (agent.installed === false) {
      statuses.push({ id: agent.id, installState: "missing" });
    } else if (agent.installed === null) {
      statuses.push({ id: agent.id, installState: "unknown" });
    }
  }
  return statuses;
}

export function resolveTerminalAgentMenuState(
  installState: TerminalAgentInstallState,
  checking: boolean,
  statusUnavailable: boolean,
): { action: TerminalAgentMenuAction; statusLabel: "Install" | "Checking…" | "Status unavailable" | null } {
  if (installState === "missing") return { action: "install", statusLabel: "Install" };
  if (installState === "unknown" && checking) return { action: "launch", statusLabel: "Checking…" };
  if (installState === "unknown" && statusUnavailable) {
    return { action: "launch", statusLabel: "Status unavailable" };
  }
  if (installState === "unknown") return { action: "launch", statusLabel: "Status unavailable" };
  return { action: "launch", statusLabel: null };
}

export function terminalAgentInstallCommand(option: TerminalAgentOption): string {
  const flags = option.installFlags?.join(" ") ?? "";
  const extraFlags = flags ? `${flags} ` : "";
  return [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    `npm install -g ${extraFlags}--prefix "$MATRIX_NODE_PREFIX" ${option.installPackage}`,
  ].join("; ");
}

export function terminalAgentVisibleInstallCommand(option: TerminalAgentOption): string {
  const command = terminalAgentInstallCommand(option);
  return `sh -lc ${shellQuote(`printf '%s\\n' ${shellQuote(command)}; ${command}`)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
