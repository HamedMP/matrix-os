import { CODEX_VERIFIED_NPM_PACKAGE } from "../../packages/contracts/src/index.js";

export type AgentInstallId = "claude" | "codex" | "opencode" | "pi";

export interface AgentInstallDefinition {
  id: AgentInstallId;
  label: string;
  binary: string;
  npmPackage: string;
  ignoreScripts: boolean;
  docsUrl: string;
  curlInstall?: {
    docsCommand: string;
    smokeCommand: string;
  };
}

export const AGENT_INSTALLS: AgentInstallDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code@latest",
    ignoreScripts: false,
    docsUrl: "https://code.claude.com/docs/en/setup",
    curlInstall: {
      docsCommand: "curl -fsSL https://claude.ai/install.sh | bash",
      smokeCommand: "curl -fsSL --connect-timeout 10 --max-time 120 https://claude.ai/install.sh | bash",
    },
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    npmPackage: CODEX_VERIFIED_NPM_PACKAGE,
    ignoreScripts: false,
    docsUrl: "https://github.com/openai/codex",
    curlInstall: {
      docsCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      smokeCommand: "curl -fsSL --connect-timeout 10 --max-time 120 https://chatgpt.com/codex/install.sh | sh",
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    npmPackage: "opencode-ai@latest",
    ignoreScripts: false,
    docsUrl: "https://opencode.ai/docs/",
    curlInstall: {
      docsCommand: "curl -fsSL https://opencode.ai/install | bash",
      smokeCommand: "curl -fsSL --connect-timeout 10 --max-time 120 https://opencode.ai/install | bash",
    },
  },
  {
    id: "pi",
    label: "Pi",
    binary: "pi",
    npmPackage: "@earendil-works/pi-coding-agent@latest",
    ignoreScripts: true,
    docsUrl: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
  },
];

export interface PackageManagerInstallDefinition {
  id: "npm" | "pnpm" | "bun" | "yarn";
  executable: string;
  commandFor(agent: AgentInstallDefinition): string;
}

function ignoreScriptsFlag(agent: AgentInstallDefinition): string {
  return agent.ignoreScripts ? "--ignore-scripts " : "";
}

function bunTrustFlag(agent: AgentInstallDefinition): string {
  return agent.ignoreScripts ? "" : "--trust ";
}

export function packageBuildName(agent: AgentInstallDefinition): string {
  return agent.npmPackage.replace(/@latest$/, "");
}

export const PACKAGE_MANAGER_INSTALLS: PackageManagerInstallDefinition[] = [
  {
    id: "npm",
    executable: "npm",
    commandFor: (agent) => `npm install -g ${ignoreScriptsFlag(agent)}--prefix "$MATRIX_NODE_PREFIX" ${agent.npmPackage}`,
  },
  {
    id: "pnpm",
    executable: "pnpm",
    commandFor: (agent) => {
      const buildFlag = agent.ignoreScripts ? "" : `--allow-build=${packageBuildName(agent)} `;
      return `PNPM_HOME="$MATRIX_NODE_PREFIX/bin" pnpm add -g ${ignoreScriptsFlag(agent)}${buildFlag}${agent.npmPackage}`;
    },
  },
  {
    id: "bun",
    executable: "bun",
    commandFor: (agent) => `BUN_INSTALL="$MATRIX_NODE_PREFIX/bun" bun install -g ${ignoreScriptsFlag(agent)}${bunTrustFlag(agent)}${agent.npmPackage}`,
  },
  {
    id: "yarn",
    executable: "yarn",
    commandFor: (agent) => `yarn global add --prefix "$MATRIX_NODE_PREFIX/yarn" ${ignoreScriptsFlag(agent)}${agent.npmPackage}`,
  },
];

export function terminalNpmInstallCommand(agent: AgentInstallDefinition): string {
  return [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    PACKAGE_MANAGER_INSTALLS[0].commandFor(agent),
  ].join("; ");
}
