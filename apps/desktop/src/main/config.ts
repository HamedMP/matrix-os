import { normalizeMatrixDesktopUrl } from "./security.js";

export type DesktopAgentMode = "cloud";

export interface MatrixDesktopConfig {
  shellUrl: string;
  gatewayUrl: string;
  agentMode: DesktopAgentMode;
}

export interface DesktopRuntimePolicy {
  shellUrl: string;
  gatewayUrl: string;
  agentExecution: {
    mode: "cloud";
    localAgentsAllowed: false;
  };
  capabilities: string[];
  version: 1;
}

const DEFAULT_SHELL_URL = "http://localhost:3000";
const DEFAULT_GATEWAY_URL = "http://localhost:4000";
const DESKTOP_CAPABILITIES = [
  "matrixShell",
  "appLauncher",
  "cloudDevelopment",
  "linearTicketSync",
  "internalTickets",
  "symphonyRunner",
] as const;

export function parseMatrixDesktopConfig(env: NodeJS.ProcessEnv = process.env): MatrixDesktopConfig {
  const requestedMode = env.MATRIX_DESKTOP_AGENT_MODE ?? "cloud";
  if (requestedMode !== "cloud") {
    throw new Error("Matrix Desktop is cloud-only; local coding agents are not supported");
  }

  try {
    return {
      shellUrl: normalizeMatrixDesktopUrl(env.MATRIX_DESKTOP_SHELL_URL ?? DEFAULT_SHELL_URL),
      gatewayUrl: normalizeMatrixDesktopUrl(env.MATRIX_DESKTOP_GATEWAY_URL ?? DEFAULT_GATEWAY_URL),
      agentMode: "cloud",
    };
  } catch (err: unknown) {
    if (!(err instanceof Error)) {
      console.warn("[desktop] Unknown desktop configuration parse failure");
    }
    throw new Error("Invalid Matrix desktop configuration");
  }
}

export function createDesktopRuntimePolicy(config: MatrixDesktopConfig): DesktopRuntimePolicy {
  return {
    shellUrl: config.shellUrl,
    gatewayUrl: config.gatewayUrl,
    agentExecution: { mode: "cloud", localAgentsAllowed: false },
    capabilities: [...DESKTOP_CAPABILITIES],
    version: 1,
  };
}
