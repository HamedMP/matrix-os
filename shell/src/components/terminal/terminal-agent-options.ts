import { CODEX_VERIFIED_NPM_PACKAGE } from "@matrix-os/contracts";

export type TerminalAgentId = "claude" | "codex" | "opencode" | "pi";

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
  installed: boolean;
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
    launchCommand: 'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"; exec "$MATRIX_NODE_PREFIX/bin/codex"',
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

export function parseTerminalAgentStatuses(value: unknown): TerminalAgentStatus[] {
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) {
    return [];
  }
  return value.agents
    .filter((agent): agent is { id: TerminalAgentId; installed: boolean } => (
      Boolean(agent) &&
      typeof agent === "object" &&
      isTerminalAgentId((agent as { id?: unknown }).id) &&
      typeof (agent as { installed?: unknown }).installed === "boolean"
    ))
    .map((agent) => ({ id: agent.id, installed: agent.installed }));
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
