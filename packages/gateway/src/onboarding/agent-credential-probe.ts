import type { AgentStatus } from "../agent-launcher.js";
import { resolveKernelCredentialMode } from "../kernel-credentials.js";
import type { AgentCredentialProbeResult } from "./agent-credential-status.js";

type ProbedAgent = Extract<AgentStatus["id"], "claude" | "codex">;

function nativeProbeResult(status: AgentStatus | undefined): AgentCredentialProbeResult {
  const condition = status?.errorCode === "agent_missing"
    ? "missing"
    : status?.errorCode === "agent_auth_required"
      ? "auth_required"
      : status?.errorCode === "agent_version_unsupported"
        ? "version_unsupported"
        : status?.errorCode === "agent_check_failed"
          ? "check_failed"
          : status?.authState === "ok"
            ? "available"
            : "check_failed";
  return { available: condition === "available", condition };
}

export async function resolveAgentCredentialProbe(
  homePath: string,
  agent: ProbedAgent,
  status: AgentStatus | undefined,
): Promise<AgentCredentialProbeResult> {
  const nativeResult = nativeProbeResult(status);
  if (
    agent !== "claude"
    || status?.installed !== true
    || status.workspaceCompatibility === "unsupported"
  ) {
    return nativeResult;
  }

  const ownerCredentialMode = await resolveKernelCredentialMode(homePath);
  return ownerCredentialMode === "platform"
    ? nativeResult
    : { available: true, condition: "available" };
}
