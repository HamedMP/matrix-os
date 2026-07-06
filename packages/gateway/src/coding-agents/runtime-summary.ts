import { relative } from "node:path";
import {
  RuntimeSummarySchema,
  type AgentProviderSummary,
  type RuntimeSummary,
  type TerminalSessionSummary,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type {
  AgentCredentialStatusResponse,
  AgentCredentialSummary,
  AgentId,
} from "../onboarding/activation-contracts.js";
import type { AgentCredentialStatusService } from "../onboarding/agent-credential-status.js";
import type { SessionInfo } from "../session-registry.js";

const TERMINAL_SUMMARY_LIMIT = 20;

export interface CodingAgentTerminalSessionRegistry {
  list(): SessionInfo[];
}

export interface CodingAgentRuntimeSummaryService {
  getSummary(principal: RequestPrincipal): Promise<RuntimeSummary>;
}

export interface CodingAgentRuntimeSummaryOptions {
  homePath: string;
  terminalRegistry?: CodingAgentTerminalSessionRegistry;
  agentCredentials?: Pick<AgentCredentialStatusService, "getStatus">;
  now?: () => Date;
  runtime?: {
    id?: string;
    label?: string;
    channel?: string;
    ownerHandle?: string;
  };
}

function safeIsoFromMillis(value: number, fallback: Date): string {
  const date = Number.isFinite(value) ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) return fallback.toISOString();
  return date.toISOString();
}

function safeCwdLabel(homePath: string, cwd: string): string {
  const rel = relative(homePath, cwd);
  if (!rel || rel === "") return "~";
  if (rel.startsWith("..") || rel.includes("\0")) return "External session";
  if (rel.length <= 120) return rel;
  return `${rel.slice(0, 117)}...`;
}

function terminalStatus(session: SessionInfo): TerminalSessionSummary["status"] {
  if (session.state === "exited") return "exited";
  if (session.attachedClients > 0) return "running";
  return "idle";
}

function terminalSummaryFromSession(homePath: string, now: Date, session: SessionInfo): TerminalSessionSummary {
  const status = terminalStatus(session);
  return {
    id: session.sessionId,
    name: safeCwdLabel(homePath, session.cwd),
    status,
    attachable: session.state === "running",
    cwdLabel: safeCwdLabel(homePath, session.cwd),
    createdAt: safeIsoFromMillis(session.createdAt, now),
    updatedAt: safeIsoFromMillis(session.lastAttachedAt, now),
  };
}

function statusToProviderSummary(agent: AgentCredentialSummary): AgentProviderSummary {
  const isAvailable = agent.status === "available";
  const isMissing = agent.status === "missing";
  const isExpired = agent.status === "expired" || agent.status === "revoked";
  const failed = agent.status === "failed";

  return {
    id: agent.agent,
    displayName: displayNameForAgent(agent.agent),
    kind: kindForAgent(agent.agent),
    availability: isAvailable
      ? "available"
      : isExpired
        ? "auth_required"
        : isMissing
          ? "setup_required"
          : failed
            ? "unavailable"
            : "unknown",
    installStatus: isAvailable || isExpired ? "installed" : isMissing ? "missing" : failed ? "failed" : "unknown",
    authStatus: isAvailable ? "authenticated" : isExpired ? "expired" : isMissing ? "missing" : "unknown",
    supportedModes: ["default", "review"],
    defaultMode: "default",
    setupActions: [],
    lastCheckedAt: agent.verifiedAt ?? undefined,
  };
}

function displayNameForAgent(agent: AgentId): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  return "Hermes";
}

function kindForAgent(agent: AgentId): AgentProviderSummary["kind"] {
  if (agent === "claude") return "claude";
  if (agent === "codex") return "codex";
  return "custom";
}

async function readProviders(
  service: Pick<AgentCredentialStatusService, "getStatus"> | undefined,
  principal: RequestPrincipal,
): Promise<AgentProviderSummary[]> {
  if (!service) return [];
  try {
    const status: AgentCredentialStatusResponse = await service.getStatus(principal.userId);
    return status.agents
      .filter((agent) => agent.agent !== "hermes")
      .map(statusToProviderSummary);
  } catch (err: unknown) {
    console.warn("[coding-agents] provider summary unavailable:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function readTerminalSessions(
  registry: CodingAgentTerminalSessionRegistry | undefined,
  homePath: string,
  now: Date,
): { items: TerminalSessionSummary[]; hasMore: boolean; limit: number } {
  if (!registry) return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  try {
    const sessions = registry.list()
      .slice()
      .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt);
    return {
      items: sessions.slice(0, TERMINAL_SUMMARY_LIMIT).map((session) => terminalSummaryFromSession(homePath, now, session)),
      hasMore: sessions.length > TERMINAL_SUMMARY_LIMIT,
      limit: TERMINAL_SUMMARY_LIMIT,
    };
  } catch (err: unknown) {
    console.warn("[coding-agents] terminal summary unavailable:", err instanceof Error ? err.message : String(err));
    return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  }
}

export function createCodingAgentRuntimeSummaryService(
  options: CodingAgentRuntimeSummaryOptions,
): CodingAgentRuntimeSummaryService {
  const nowFn = options.now ?? (() => new Date());

  return {
    async getSummary(principal: RequestPrincipal): Promise<RuntimeSummary> {
      const now = nowFn();
      const terminalSessions = readTerminalSessions(options.terminalRegistry, options.homePath, now);
      const providers = await readProviders(options.agentCredentials, principal);

      return RuntimeSummarySchema.parse({
        runtime: {
          id: options.runtime?.id ?? "rt_primary",
          label: options.runtime?.label ?? "Primary Matrix computer",
          status: "available",
          channel: options.runtime?.channel,
          ownerHandle: options.runtime?.ownerHandle,
        },
        capabilities: [
          { id: "codingAgentsRuntimeSummary", enabled: true },
          { id: "codingAgentsDesktopWorkspace", enabled: false, reason: "Not enabled yet" },
          { id: "codingAgentsMobileWorkspace", enabled: false, reason: "Not enabled yet" },
          { id: "codingAgentsThreadCreate", enabled: false, reason: "Not enabled yet" },
          { id: "codingAgentsApprovals", enabled: false, reason: "Not enabled yet" },
          { id: "codingAgentsReview", enabled: false, reason: "Not enabled yet" },
          { id: "codingAgentsNativeMobileTerminal", enabled: false, reason: "Not enabled yet" },
        ],
        providers,
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        terminalSessions,
        recentActivity: { items: [], hasMore: false, limit: 30 },
        limits: {
          maxPromptBytes: 24_000,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 65_536,
          maxListItems: 50,
        },
        serverTime: now.toISOString(),
      });
    },
  };
}
