import { CODEX_VERIFIED_NPM_PACKAGE } from "@matrix-os/contracts";

export type TerminalAgentId = "claude" | "codex" | "opencode" | "pi";
export type TerminalAgentInstallState = "installed" | "missing" | "unknown";
export type TerminalAgentMenuAction = "launch" | "install";

export interface TerminalAgentOption {
  id: TerminalAgentId;
  label: string;
  shortLabel: string;
  color: string;
  logoSrc: string;
  launchCommand: string;
  installPackage: string;
  installFlags?: string[];
}

export const TERMINAL_AGENT_OPTIONS: readonly TerminalAgentOption[] = [
  {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    color: "#D8792C",
    logoSrc: "agent-logos/claude-code.png",
    launchCommand: "claude",
    installPackage: "@anthropic-ai/claude-code@latest",
  },
  {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    color: "#465243",
    logoSrc: "agent-logos/codex.png",
    launchCommand: "codex",
    installPackage: CODEX_VERIFIED_NPM_PACKAGE,
  },
  {
    id: "opencode",
    label: "OpenCode",
    shortLabel: "OpenCode",
    color: "#111111",
    logoSrc: "agent-logos/opencode-white.png",
    launchCommand: "opencode",
    installPackage: "opencode-ai@latest",
  },
  {
    id: "pi",
    label: "Pi",
    shortLabel: "Pi",
    color: "#1E2F5C",
    logoSrc: "agent-logos/pi-coding-agent.png",
    launchCommand: "pi",
    installPackage: "@earendil-works/pi-coding-agent@latest",
    installFlags: ["--ignore-scripts"],
  },
];

export const UNKNOWN_TERMINAL_AGENT_STATUSES: Record<TerminalAgentId, TerminalAgentInstallState> = {
  claude: "unknown",
  codex: "unknown",
  opencode: "unknown",
  pi: "unknown",
};

export function parseTerminalAgentStatuses(value: unknown): Record<TerminalAgentId, TerminalAgentInstallState> {
  const statuses = { ...UNKNOWN_TERMINAL_AGENT_STATUSES };
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) {
    return statuses;
  }
  for (const candidate of value.agents) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as { id?: unknown; installState?: unknown; installed?: unknown };
    const option = TERMINAL_AGENT_OPTIONS.find(({ id }) => id === record.id);
    if (!option) continue;
    if (record.installState === "installed" || record.installState === "missing" || record.installState === "unknown") {
      statuses[option.id] = record.installState;
    } else if (record.installed === true) {
      statuses[option.id] = "installed";
    } else if (record.installed === false) {
      statuses[option.id] = "missing";
    }
  }
  return statuses;
}

export function terminalAgentAction(state: TerminalAgentInstallState): TerminalAgentMenuAction | null {
  if (state === "unknown") return null;
  return state === "missing" ? "install" : "launch";
}

export function terminalAgentVisibleInstallCommand(option: TerminalAgentOption): string {
  const flags = option.installFlags?.join(" ") ?? "";
  const extraFlags = flags ? `${flags} ` : "";
  const command = [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    `npm install -g ${extraFlags}--prefix "$MATRIX_NODE_PREFIX" ${option.installPackage}`,
  ].join("; ");
  return `sh -lc ${shellQuote(`printf '%s\\n' ${shellQuote(command)}; ${command}`)}`;
}

export function terminalAgentLabel(agent: TerminalAgentId): string {
  return TERMINAL_AGENT_OPTIONS.find((option) => option.id === agent)?.shortLabel ?? agent;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
