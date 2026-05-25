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

function claudeSummary(verifiedAt: string | undefined): AgentCredentialSummary {
  return {
    agent: "claude",
    status: verifiedAt ? "available" : "missing",
    coordinationRole: "core_agent",
    workflows: ["core_agent"],
    degradedWorkflows: verifiedAt ? [] : ["core_agent"],
    verifiedAt: verifiedAt ?? null,
    nextAction: verifiedAt ? null : "Connect Claude to enable the core agent path",
  };
}

function codexSummary(verifiedAt: string | undefined): AgentCredentialSummary {
  return {
    agent: "codex",
    status: verifiedAt ? "available" : "missing",
    coordinationRole: "coding_specialist",
    workflows: ["coding"],
    degradedWorkflows: verifiedAt ? [] : ["coding"],
    verifiedAt: verifiedAt ?? null,
    nextAction: verifiedAt ? null : "Connect Codex for optional coding support",
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
      return { available: false };
    }
  }

  async function getStatus(ownerId: string): Promise<AgentCredentialStatusResponse> {
    if (options.probeAgent) {
      const [claude, codex] = await Promise.all([
        probeAvailability(ownerId, "claude"),
        probeAvailability(ownerId, "codex"),
      ]);
      const verifiedAt = now().toISOString();
      return {
        systemAgent: "hermes",
        activeAgents: activeAgentsFromAvailability(claude.available, codex.available),
        routingExplanation: "Hermes remains the Matrix system agent while Claude and Codex add optional specialist paths when connected.",
        agents: [
          claudeSummary(claude.available ? verifiedAt : undefined),
          codexSummary(codex.available ? verifiedAt : undefined),
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
        claudeSummary(state.claudeVerifiedAt),
        codexSummary(state.codexVerifiedAt),
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
      if (!probe.available) {
        throw new ActivationRouteError(
          probe.missing ? "agent_not_installed" : "agent_auth_required",
          probe.missing ? "Install the agent before verifying credentials" : "Log in to the agent before verifying credentials",
          { status: 409, retryable: true },
        );
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
