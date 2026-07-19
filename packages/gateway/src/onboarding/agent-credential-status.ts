import type {
  AgentCredentialStatusResponse,
  AgentCredentialSummary,
  AgentId,
  VerifyAgentCredentialResponse,
} from "./activation-contracts.js";
import { ActivationRouteError } from "./activation-errors.js";

const MAX_OWNERS = 512;

export interface AgentCredentialStatusService {
  getStatus(ownerId: string): Promise<AgentCredentialStatusResponse>;
  verifyAgent(ownerId: string, agent: AgentId): Promise<VerifyAgentCredentialResponse>;
}

export interface AgentCredentialProbeResult {
  available: boolean;
  condition?: "available" | "missing" | "auth_required" | "check_failed" | "version_unsupported";
  /** @deprecated Use condition: "missing". */
  missing?: boolean;
}

interface StoredCredentialState {
  claudeVerifiedAt?: string;
  codexVerifiedAt?: string;
}

function hermesSummary(): AgentCredentialSummary {
  return {
    agent: "hermes",
    status: "available",
    coordinationRole: "system_agent",
    workflows: ["app_building", "assistant", "integrations", "company_brain"],
    degradedWorkflows: [],
    verifiedAt: null,
    nextAction: null,
  };
}

function probeCondition(result: AgentCredentialProbeResult): NonNullable<AgentCredentialProbeResult["condition"]> {
  if (result.condition) return result.condition;
  if (result.available) return "available";
  return result.missing ? "missing" : "auth_required";
}

function claudeSummary(
  condition: NonNullable<AgentCredentialProbeResult["condition"]>,
  verifiedAt: string | undefined,
): AgentCredentialSummary {
  return {
    agent: "claude",
    status: condition,
    coordinationRole: "core_agent",
    workflows: ["core_agent"],
    degradedWorkflows: condition === "available" ? [] : ["core_agent"],
    verifiedAt: verifiedAt ?? null,
    nextAction: condition === "available"
      ? null
      : condition === "missing"
        ? "Install the agent to enable the core agent path"
        : condition === "auth_required"
          ? "Log in to the agent to enable the core agent path"
          : "Agent setup status could not be verified",
  };
}

function codexSummary(
  condition: NonNullable<AgentCredentialProbeResult["condition"]>,
  verifiedAt: string | undefined,
): AgentCredentialSummary {
  return {
    agent: "codex",
    status: condition,
    coordinationRole: "coding_specialist",
    workflows: ["coding"],
    degradedWorkflows: condition === "available" ? [] : ["coding"],
    verifiedAt: verifiedAt ?? null,
    nextAction: condition === "available"
      ? null
      : condition === "missing"
        ? "Install the agent for optional coding support"
        : condition === "auth_required"
          ? "Log in to the agent for optional coding support"
          : condition === "version_unsupported"
            ? "Install the verified agent version for structured coding sessions"
            : "Agent setup status could not be verified",
  };
}

function activeAgents(state: StoredCredentialState): AgentId[] {
  const agents: AgentId[] = [];
  if (state.claudeVerifiedAt) agents.push("claude");
  if (state.codexVerifiedAt) agents.push("codex");
  agents.push("hermes");
  return agents;
}

function activeAgentsFromAvailability(claudeAvailable: boolean, codexAvailable: boolean): AgentId[] {
  const agents: AgentId[] = [];
  if (claudeAvailable) agents.push("claude");
  if (codexAvailable) agents.push("codex");
  agents.push("hermes");
  return agents;
}

export function createAgentCredentialStatusService(options: {
  now?: () => Date;
  onChange?: (ownerId: string) => void;
  probeAgent?: (ownerId: string, agent: Extract<AgentId, "claude" | "codex">) => Promise<AgentCredentialProbeResult>;
} = {}): AgentCredentialStatusService {
  const now = options.now ?? (() => new Date());
  // Production gateway wires probeAgent, so Claude/Codex status is derived
  // live from local agent login state. The bounded map is only the fallback
  // for tests or local harnesses that do not have a probe.
  const states = new Map<string, StoredCredentialState>();

  function getState(ownerId: string): StoredCredentialState {
    const existing = states.get(ownerId);
    if (existing) {
      states.delete(ownerId);
      states.set(ownerId, existing);
      return existing;
    }
    if (states.size >= MAX_OWNERS) {
      const oldestKey = states.keys().next().value as string | undefined;
      if (oldestKey) states.delete(oldestKey);
    }
    const next: StoredCredentialState = {};
    states.set(ownerId, next);
    return next;
  }

  async function probeAvailability(
    ownerId: string,
    agent: Extract<AgentId, "claude" | "codex">,
  ): Promise<AgentCredentialProbeResult> {
    try {
      return await options.probeAgent!(ownerId, agent);
    } catch (err: unknown) {
      console.warn("[onboarding] agent availability probe failed:", err instanceof Error ? err.message : String(err));
      return { available: false, condition: "check_failed" };
    }
  }

  async function getStatus(ownerId: string): Promise<AgentCredentialStatusResponse> {
    if (options.probeAgent) {
      const [claude, codex] = await Promise.all([
        probeAvailability(ownerId, "claude"),
        probeAvailability(ownerId, "codex"),
      ]);
      const verifiedAt = now().toISOString();
      const claudeCondition = probeCondition(claude);
      const codexCondition = probeCondition(codex);
      return {
        systemAgent: "hermes",
        activeAgents: activeAgentsFromAvailability(claudeCondition === "available", codexCondition === "available"),
        routingExplanation: "Hermes remains the Matrix system agent while Claude and Codex add optional specialist paths when connected.",
        agents: [
          claudeSummary(claudeCondition, claudeCondition === "available" ? verifiedAt : undefined),
          codexSummary(codexCondition, codexCondition === "available" ? verifiedAt : undefined),
          hermesSummary(),
        ],
      };
    }
    const state = getState(ownerId);
    return {
      systemAgent: "hermes",
      activeAgents: activeAgents(state),
      routingExplanation: "Hermes remains the Matrix system agent while Claude and Codex add optional specialist paths when connected.",
      agents: [
        claudeSummary(state.claudeVerifiedAt ? "available" : "missing", state.claudeVerifiedAt),
        codexSummary(state.codexVerifiedAt ? "available" : "missing", state.codexVerifiedAt),
        hermesSummary(),
      ],
    };
  }

  async function verifyAgent(ownerId: string, agent: AgentId): Promise<VerifyAgentCredentialResponse> {
    if (agent !== "claude" && agent !== "codex") {
      throw new ActivationRouteError("invalid_request", "Agent credential verification is not supported for this agent", { status: 400 });
    }
    if (options.probeAgent) {
      const probe = await options.probeAgent(ownerId, agent);
      const condition = probeCondition(probe);
      if (condition !== "available") {
        if (condition === "missing") {
          throw new ActivationRouteError("agent_not_installed", "Install the agent before verifying credentials", { status: 409, retryable: true });
        }
        if (condition === "auth_required") {
          throw new ActivationRouteError("agent_auth_required", "Log in to the agent before verifying credentials", { status: 409, retryable: true });
        }
        if (condition === "version_unsupported") {
          throw new ActivationRouteError("agent_version_unsupported", "Install the verified agent version before using structured sessions", { status: 409, retryable: true });
        }
        throw new ActivationRouteError("agent_check_failed", "Agent setup status could not be verified", { status: 503, retryable: true });
      }
      const verifiedAt = now().toISOString();
      options.onChange?.(ownerId);
      return { agent, status: "available", verifiedAt };
    }
    const verifiedAt = now().toISOString();
    const state = getState(ownerId);
    if (agent === "claude") state.claudeVerifiedAt = verifiedAt;
    if (agent === "codex") state.codexVerifiedAt = verifiedAt;
    options.onChange?.(ownerId);
    return { agent, status: "available", verifiedAt };
  }

  return { getStatus, verifyAgent };
}
