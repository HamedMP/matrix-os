import { randomUUID } from "node:crypto";
import type {
  AgentActionStatus,
  AgentActionSummary,
  AgentId,
} from "./activation-contracts.js";

const MAX_ACTIONS = 500;
const UNSAFE_DISPLAY = /(secret|token|postgres|pipedream|anthropic|\bsk[-_][a-z0-9]+|\/home\/|\/tmp\/|database)/i;

export interface AgentActionAuditService {
  recordAction(ownerId: string, input: {
    agent: AgentId;
    capability: string;
    status: AgentActionStatus;
    summary: string;
    target: string;
  }): Promise<AgentActionSummary>;
  listActions(ownerId: string): Promise<AgentActionSummary[]>;
}

function safeDisplay(value: string, fallback: string): string {
  const trimmed = value.trim().slice(0, 220);
  if (!trimmed || UNSAFE_DISPLAY.test(trimmed)) return fallback;
  return trimmed;
}

export function createAgentActionAuditService(options: {
  now?: () => Date;
} = {}): AgentActionAuditService {
  const now = options.now ?? (() => new Date());
  const actions = new Map<string, AgentActionSummary[]>();

  async function recordAction(ownerId: string, input: {
    agent: AgentId;
    capability: string;
    status: AgentActionStatus;
    summary: string;
    target: string;
  }): Promise<AgentActionSummary> {
    const timestamp = now().toISOString();
    const action: AgentActionSummary = {
      id: `action.${randomUUID()}`,
      agent: input.agent,
      capability: input.capability,
      status: input.status,
      summary: safeDisplay(input.summary, "Agent action completed"),
      target: safeDisplay(input.target, "Connected service"),
      createdAt: timestamp,
      completedAt: ["completed", "failed", "denied"].includes(input.status) ? timestamp : null,
    };
    const ownerActions = actions.get(ownerId) ?? [];
    ownerActions.push(action);
    while (ownerActions.length > MAX_ACTIONS) ownerActions.shift();
    actions.set(ownerId, ownerActions);
    return action;
  }

  async function listActions(ownerId: string): Promise<AgentActionSummary[]> {
    return [...(actions.get(ownerId) ?? [])];
  }

  return { recordAction, listActions };
}
