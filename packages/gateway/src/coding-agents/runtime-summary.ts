import {
  PreviewSessionSummarySchema,
  RuntimeSummarySchema,
  SafeDisplayStringSchema,
  TerminalSessionIdSchema,
  type AgentProviderSummary,
  type AgentThreadSummary,
  type PreviewSessionSummary,
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

const TERMINAL_SUMMARY_LIMIT = 20;
const PREVIEW_SUMMARY_LIMIT = 50;

export interface CodingAgentTerminalSession {
  name: string;
  status?: "active" | "exited";
  visualStatus?: "running" | "finished" | "idle" | "waiting";
  createdAt: string;
  updatedAt: string;
  attachedClients?: number;
  recoverable?: boolean;
}

export interface CodingAgentTerminalSessionRegistry {
  list(): Promise<CodingAgentTerminalSession[]> | CodingAgentTerminalSession[];
}

export interface CodingAgentRuntimeSummaryService {
  getSummary(principal: RequestPrincipal): Promise<RuntimeSummary>;
}

export interface CodingAgentThreadSummaryStore {
  listThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
  listAttentionThreads?(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
}

export interface CodingAgentPreviewSummaryStore {
  listPreviewSessions(principal: RequestPrincipal): Promise<{ items: PreviewSessionSummary[]; hasMore: boolean; limit: number }>;
}

export interface CodingAgentRuntimeSummaryOptions {
  homePath: string;
  terminalRegistry?: CodingAgentTerminalSessionRegistry;
  agentCredentials?: Pick<AgentCredentialStatusService, "getStatus">;
  threads?: CodingAgentThreadSummaryStore;
  previews?: CodingAgentPreviewSummaryStore;
  capabilities?: {
    workspace?: boolean;
    approvals?: boolean;
    review?: boolean;
    preview?: boolean;
  };
  terminalOwnerId?: string;
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

function safeDisplayLabel(value: string, fallback: string): { label: string; sanitized: boolean } {
  const label = value.length <= 120 ? value : `${value.slice(0, 117)}...`;
  return SafeDisplayStringSchema.safeParse(label).success
    ? { label, sanitized: false }
    : { label: fallback, sanitized: true };
}

function canReadTerminalSessions(principal: RequestPrincipal, terminalOwnerId: string | undefined): boolean {
  if (terminalOwnerId) return principal.userId === terminalOwnerId;
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function terminalStatus(session: CodingAgentTerminalSession): TerminalSessionSummary["status"] {
  if (session.status === "exited") return "exited";
  if (session.recoverable) return "stale";
  if (session.visualStatus === "waiting") return "idle";
  if (session.visualStatus === "finished") return "idle";
  if (session.visualStatus === "running") return "running";
  if ((session.attachedClients ?? 0) > 0) return "running";
  return "idle";
}

function terminalSummaryFromSession(
  _homePath: string,
  now: Date,
  session: CodingAgentTerminalSession,
  index: number,
): TerminalSessionSummary {
  const status = terminalStatus(session);
  const safeName = safeDisplayLabel(session.name, "Private session");
  const safeId = TerminalSessionIdSchema.safeParse(session.name);
  const canAttach = safeId.success && !safeName.sanitized && session.status !== "exited" && !session.recoverable;
  return {
    id: safeId.success && !safeName.sanitized ? safeId.data : `terminal_private_${index}`,
    name: safeName.label,
    status,
    attachable: canAttach,
    createdAt: safeIsoFromMillis(Date.parse(session.createdAt), now),
    updatedAt: safeIsoFromMillis(Date.parse(session.updatedAt), now),
  };
}

function capability(input: { id: RuntimeSummary["capabilities"][number]["id"]; enabled: boolean }) {
  return input.enabled
    ? { id: input.id, enabled: true }
    : { id: input.id, enabled: false, reason: "Not enabled yet" };
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

async function readActiveThreads(
  store: CodingAgentThreadSummaryStore | undefined,
  principal: RequestPrincipal,
): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }> {
  if (!store) return { items: [], hasMore: false, limit: 20 };
  try {
    return await store.listThreads(principal);
  } catch (err: unknown) {
    console.warn("[coding-agents] thread summary unavailable:", err instanceof Error ? err.message : String(err));
    return { items: [], hasMore: false, limit: 20 };
  }
}

async function readAttentionThreads(
  store: CodingAgentThreadSummaryStore | undefined,
  principal: RequestPrincipal,
): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }> {
  if (!store?.listAttentionThreads) return { items: [], hasMore: false, limit: 20 };
  try {
    return await store.listAttentionThreads(principal);
  } catch (err: unknown) {
    console.warn("[coding-agents] attention summary unavailable:", err instanceof Error ? err.message : String(err));
    return { items: [], hasMore: false, limit: 20 };
  }
}

async function readPreviewSessions(
  store: CodingAgentPreviewSummaryStore | undefined,
  principal: RequestPrincipal,
): Promise<{ items: PreviewSessionSummary[]; hasMore: boolean; limit: number }> {
  if (!store) return { items: [], hasMore: false, limit: PREVIEW_SUMMARY_LIMIT };
  try {
    const sessions = await store.listPreviewSessions(principal);
    const parsed: PreviewSessionSummary[] = [];
    for (const item of sessions.items.slice(0, PREVIEW_SUMMARY_LIMIT + 1)) {
      const result = PreviewSessionSummarySchema.safeParse(item);
      if (result.success) parsed.push(result.data);
    }
    return {
      items: parsed.slice(0, PREVIEW_SUMMARY_LIMIT),
      hasMore: sessions.hasMore || parsed.length > PREVIEW_SUMMARY_LIMIT,
      limit: PREVIEW_SUMMARY_LIMIT,
    };
  } catch (err: unknown) {
    console.warn("[coding-agents] preview summary unavailable:", err instanceof Error ? err.message : String(err));
    return { items: [], hasMore: false, limit: PREVIEW_SUMMARY_LIMIT };
  }
}

async function readTerminalSessions(
  registry: CodingAgentTerminalSessionRegistry | undefined,
  homePath: string,
  now: Date,
  principal: RequestPrincipal,
  terminalOwnerId: string | undefined,
): Promise<{ items: TerminalSessionSummary[]; hasMore: boolean; limit: number }> {
  if (!registry) return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  if (!canReadTerminalSessions(principal, terminalOwnerId)) {
    return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  }
  try {
    const sessions = (await registry.list())
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return {
      items: sessions.slice(0, TERMINAL_SUMMARY_LIMIT).map((session, index) =>
        terminalSummaryFromSession(homePath, now, session, index)
      ),
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
      const terminalSessions = readTerminalSessions(
        options.terminalRegistry,
        options.homePath,
        now,
        principal,
        options.terminalOwnerId,
      );
      const providers = await readProviders(options.agentCredentials, principal);
      const activeThreads = await readActiveThreads(options.threads, principal);
      const attentionThreads = await readAttentionThreads(options.threads, principal);
      const previewSessions = readPreviewSessions(options.previews, principal);
      const threadsEnabled = Boolean(options.threads);
      const workspaceEnabled = threadsEnabled && options.capabilities?.workspace === true;
      const approvalsEnabled = threadsEnabled && options.capabilities?.approvals === true;
      const reviewEnabled = options.capabilities?.review === true;
      const previewEnabled = Boolean(options.previews) && options.capabilities?.preview === true;
      const terminalEnabled = Boolean(options.terminalRegistry) &&
        canReadTerminalSessions(principal, options.terminalOwnerId);

      return RuntimeSummarySchema.parse({
        runtime: {
          id: options.runtime?.id ?? "rt_primary",
          label: options.runtime?.label ?? "Primary Matrix computer",
          status: "available",
          channel: options.runtime?.channel,
          ownerHandle: options.runtime?.ownerHandle,
        },
        capabilities: [
          capability({ id: "codingAgentsRuntimeSummary", enabled: true }),
          capability({ id: "codingAgentsDesktopWorkspace", enabled: workspaceEnabled }),
          capability({ id: "codingAgentsMobileWorkspace", enabled: workspaceEnabled }),
          capability({ id: "codingAgentsThreadCreate", enabled: threadsEnabled }),
          capability({ id: "codingAgentsApprovals", enabled: approvalsEnabled }),
          capability({ id: "codingAgentsReview", enabled: reviewEnabled }),
          capability({ id: "codingAgentsPreview", enabled: previewEnabled }),
          capability({ id: "codingAgentsNativeMobileTerminal", enabled: terminalEnabled }),
        ],
        providers,
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads,
        attentionThreads,
        terminalSessions: await terminalSessions,
        previewSessions: await previewSessions,
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
