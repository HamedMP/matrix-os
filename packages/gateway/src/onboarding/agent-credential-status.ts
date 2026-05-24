import type {
  AgentCredentialStatusResponse,
  AgentCredentialSummary,
  AgentId,
  VerifyAgentCredentialResponse,
} from "./activation-contracts.js";

const MAX_OWNERS = 512;

export interface AgentCredentialStatusService {
  getStatus(ownerId: string): Promise<AgentCredentialStatusResponse>;
  verifyAgent(ownerId: string, agent: AgentId): Promise<VerifyAgentCredentialResponse>;
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

export function createAgentCredentialStatusService(options: {
  now?: () => Date;
  onChange?: (ownerId: string) => void;
} = {}): AgentCredentialStatusService {
  const now = options.now ?? (() => new Date());
  // TODO(082): replace this launch scaffold with owner-scoped credential probes backed by durable agent settings.
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

  async function getStatus(ownerId: string): Promise<AgentCredentialStatusResponse> {
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
    const verifiedAt = now().toISOString();
    const state = getState(ownerId);
    if (agent === "claude") state.claudeVerifiedAt = verifiedAt;
    if (agent === "codex") state.codexVerifiedAt = verifiedAt;
    options.onChange?.(ownerId);
    return { agent, status: "available", verifiedAt };
  }

  return { getStatus, verifyAgent };
}
