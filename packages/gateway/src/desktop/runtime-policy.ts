import { DESKTOP_CAPABILITIES } from "./capabilities.js";
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

export interface DesktopOperatorAuthorizationInput {
  ownerId: string;
  principalUserId: string;
  operatorIds?: string[];
}

const SAFE_DESKTOP_OPERATOR_ID = /^[A-Za-z0-9_-]{1,256}$/;

function normalizeWebUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn("[desktop] Runtime URL parse failed:", err instanceof Error ? err.name : "UnknownError");
    }
    throw new Error("Invalid Matrix desktop runtime URL");
  }
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

export function normalizeDesktopOperators(operatorIds: readonly string[] = []): string[] {
  return Array.from(new Set(operatorIds.filter((id) => SAFE_DESKTOP_OPERATOR_ID.test(id)))).slice(0, 50);
}

export function canUseDesktopOperatorControls(input: DesktopOperatorAuthorizationInput): boolean {
  if (!SAFE_DESKTOP_OPERATOR_ID.test(input.ownerId) || !SAFE_DESKTOP_OPERATOR_ID.test(input.principalUserId)) {
    return false;
  }
  return input.principalUserId === input.ownerId || normalizeDesktopOperators(input.operatorIds).includes(input.principalUserId);
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
