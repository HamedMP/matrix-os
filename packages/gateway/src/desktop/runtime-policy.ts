import type { DesktopRuntimePolicyResponse } from "./contracts.js";

export interface GatewayDesktopRuntimePolicyInput {
  shellUrl: string;
  gatewayUrl: string;
  version: string;
  gatewayHealth?: "healthy" | "degraded" | "unreachable";
}

export interface AgentRuntimeRequest {
  mode?: string;
}

const DESKTOP_CAPABILITIES = [
  "matrixShell",
  "appLauncher",
  "cloudDevelopment",
  "linearTicketSync",
  "internalTickets",
  "symphonyRunner",
] as const;

function normalizeWebUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid Matrix desktop runtime URL");
  }
  return parsed.toString();
}

export function assertCloudAgentRuntime(request: AgentRuntimeRequest): void {
  if (request.mode === undefined || request.mode === "cloud") {
    return;
  }
  throw new Error("Cloud agent runtime required");
}

export function createGatewayDesktopRuntimePolicy(
  input: GatewayDesktopRuntimePolicyInput,
): DesktopRuntimePolicyResponse {
  return {
    agentExecution: { mode: "cloud", localAgentsAllowed: false },
    capabilities: [...DESKTOP_CAPABILITIES],
    gatewayHealth: input.gatewayHealth ?? "healthy",
    instance: {
      shellUrl: normalizeWebUrl(input.shellUrl),
      gatewayUrl: normalizeWebUrl(input.gatewayUrl),
      version: input.version,
    },
    version: 1,
  };
}
