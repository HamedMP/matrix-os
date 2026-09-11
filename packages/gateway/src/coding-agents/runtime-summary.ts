import {
  PreviewSessionSummarySchema,
  ProjectSummarySchema,
  RuntimeSummarySchema,
  type AgentProviderSummary,
  type AgentThreadSummary,
  type PreviewSessionSummary,
  type RuntimeSummary,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type {
  AgentCredentialStatusResponse,
  AgentCredentialSummary,
  AgentId,
} from "../onboarding/activation-contracts.js";
import type { AgentCredentialStatusService } from "../onboarding/agent-credential-status.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import {
  applyCredentialState,
  type CodingAgentProviderRegistry,
} from "./provider-registry.js";

const TERMINAL_SUMMARY_LIMIT = 20;
const PREVIEW_SUMMARY_LIMIT = 50;
export const CODING_AGENT_PROJECT_SUMMARY_LIMIT = 50;
const DEFAULT_PROJECT_SUMMARY_TIMEOUT_MS = 2_000;
const MAX_PROJECT_SUMMARY_TIMEOUT_MS = 10_000;

type ProjectSummary = ReturnType<typeof ProjectSummarySchema.parse>;

export interface CodingAgentTerminalWorkspaceRegistry {
  list(): Promise<TerminalWorkspace[]> | TerminalWorkspace[];
}

export interface CodingAgentRuntimeSummaryService {
  getSummary(principal: RequestPrincipal, options?: CodingAgentRuntimeSummaryRequestOptions): Promise<RuntimeSummary>;
}

export interface CodingAgentRuntimeSummaryRequestOptions {
  projectId?: string;
}

export interface CodingAgentThreadSummaryStore {
  listThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
  listAttentionThreads?(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
}

export interface CodingAgentPreviewSummaryStore {
  listPreviewSessions(
    principal: RequestPrincipal,
    options?: CodingAgentRuntimeSummaryRequestOptions,
  ): Promise<{ items: PreviewSessionSummary[]; hasMore: boolean; limit: number }>;
}

export interface CodingAgentProjectSummaryStore {
  listProjectSummaries(
    principal: RequestPrincipal,
    signal: AbortSignal,
  ): Promise<{ items: ProjectSummary[]; hasMore: boolean; limit: number }>;
}

export interface CodingAgentRuntimeSummaryOptions {
  homePath: string;
  terminalRegistry?: CodingAgentTerminalWorkspaceRegistry;
  providerRegistry?: Pick<CodingAgentProviderRegistry, "listProviders">;
  agentCredentials?: Pick<AgentCredentialStatusService, "getStatus">;
  threads?: CodingAgentThreadSummaryStore;
  previews?: CodingAgentPreviewSummaryStore;
  projects?: CodingAgentProjectSummaryStore;
  capabilities?: {
    projectWorkspace?: boolean;
    conversationView?: boolean;
    kanbanView?: boolean;
    workspace?: boolean;
    sameThreadTurns?: boolean;
    approvals?: boolean;
    review?: boolean;
    preview?: boolean;
    files?: boolean;
    sourceControl?: boolean;
  };
  projectSummaryTimeoutMs?: number;
  providerIds?: readonly string[];
  terminalOwnerId?: string;
  filesOwnerId?: string;
  now?: () => Date;
  runtime?: {
    id?: string;
    label?: string;
    channel?: string;
    ownerHandle?: string;
  };
}

function canReadTerminalWorkspaces(principal: RequestPrincipal, terminalOwnerId: string | undefined): boolean {
  if (terminalOwnerId) return principal.userId === terminalOwnerId;
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function canReadOwnerResource(principal: RequestPrincipal, ownerId: string | undefined): boolean {
  if (ownerId) return principal.userId === ownerId;
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function capability(input: {
  id: RuntimeSummary["capabilities"][number]["id"];
  enabled: boolean;
  reason?: string;
}) {
  return input.enabled
    ? { id: input.id, enabled: true }
    : { id: input.id, enabled: false, reason: input.reason ?? "Not enabled yet" };
}

function statusToProviderSummary(agent: AgentCredentialSummary): AgentProviderSummary {
  return applyCredentialState({
    id: agent.agent,
    displayName: displayNameForAgent(agent.agent),
    kind: kindForAgent(agent.agent),
    availability: "available",
    installStatus: "unknown",
    authStatus: "unknown",
    supportedModes: ["default", "review"],
    defaultMode: "default",
    setupActions: [],
    lastCheckedAt: agent.verifiedAt ?? undefined,
  }, agent);
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
  providerIds: readonly string[] | undefined,
): Promise<AgentProviderSummary[]> {
  if (!service) return [];
  try {
    const status: AgentCredentialStatusResponse = await service.getStatus(principal.userId);
    const registeredProviderIds = providerIds ? new Set(providerIds) : null;
    return status.agents
      .filter((agent) => agent.agent !== "hermes")
      .filter((agent) => !registeredProviderIds || registeredProviderIds.has(agent.agent))
      .map(statusToProviderSummary);
  } catch (err: unknown) {
    logCodingAgentWarning("provider summary unavailable", err);
    return [];
  }
}

async function readRegisteredProviders(
  registry: Pick<CodingAgentProviderRegistry, "listProviders">,
  principal: RequestPrincipal,
): Promise<AgentProviderSummary[]> {
  try {
    return await registry.listProviders(principal);
  } catch (err: unknown) {
    logCodingAgentWarning("provider registry unavailable", err);
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
    logCodingAgentWarning("thread summary unavailable", err);
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
    logCodingAgentWarning("attention summary unavailable", err);
    return { items: [], hasMore: false, limit: 20 };
  }
}

async function readPreviewSessions(
  store: CodingAgentPreviewSummaryStore | undefined,
  principal: RequestPrincipal,
  options: CodingAgentRuntimeSummaryRequestOptions,
): Promise<{ items: PreviewSessionSummary[]; hasMore: boolean; limit: number }> {
  if (!store) return { items: [], hasMore: false, limit: PREVIEW_SUMMARY_LIMIT };
  try {
    const sessions = await store.listPreviewSessions(principal, options);
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
    logCodingAgentWarning("preview summary unavailable", err);
    return { items: [], hasMore: false, limit: PREVIEW_SUMMARY_LIMIT };
  }
}

async function readProjects(
  store: CodingAgentProjectSummaryStore | undefined,
  principal: RequestPrincipal,
  timeoutMs: number,
): Promise<{
  page: { items: ProjectSummary[]; hasMore: boolean; limit: number };
  available: boolean;
}> {
  const empty = { items: [], hasMore: false, limit: CODING_AGENT_PROJECT_SUMMARY_LIMIT };
  if (!store) return { page: empty, available: false };
  try {
    const result = await store.listProjectSummaries(principal, AbortSignal.timeout(timeoutMs));
    const items: ProjectSummary[] = [];
    for (const item of result.items.slice(0, CODING_AGENT_PROJECT_SUMMARY_LIMIT + 1)) {
      const parsed = ProjectSummarySchema.safeParse(item);
      if (parsed.success) items.push(parsed.data);
    }
    return {
      page: {
        items: items.slice(0, CODING_AGENT_PROJECT_SUMMARY_LIMIT),
        hasMore: result.hasMore || result.items.length > CODING_AGENT_PROJECT_SUMMARY_LIMIT,
        limit: CODING_AGENT_PROJECT_SUMMARY_LIMIT,
      },
      available: true,
    };
  } catch (err: unknown) {
    logCodingAgentWarning("project summary unavailable", err);
    return { page: empty, available: false };
  }
}

async function readTerminalWorkspaces(
  registry: CodingAgentTerminalWorkspaceRegistry | undefined,
  principal: RequestPrincipal,
  terminalOwnerId: string | undefined,
): Promise<{ items: TerminalWorkspace[]; hasMore: boolean; limit: number }> {
  if (!registry) return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  if (!canReadTerminalWorkspaces(principal, terminalOwnerId)) {
    return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  }
  try {
    const workspaces = (await registry.list())
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return {
      items: workspaces.slice(0, TERMINAL_SUMMARY_LIMIT),
      hasMore: workspaces.length > TERMINAL_SUMMARY_LIMIT,
      limit: TERMINAL_SUMMARY_LIMIT,
    };
  } catch (err: unknown) {
    logCodingAgentWarning("terminal summary unavailable", err);
    return { items: [], hasMore: false, limit: TERMINAL_SUMMARY_LIMIT };
  }
}

export function createCodingAgentRuntimeSummaryService(
  options: CodingAgentRuntimeSummaryOptions,
): CodingAgentRuntimeSummaryService {
  const nowFn = options.now ?? (() => new Date());

  return {
    async getSummary(
      principal: RequestPrincipal,
      summaryOptions: CodingAgentRuntimeSummaryRequestOptions = {},
    ): Promise<RuntimeSummary> {
      const now = nowFn();
      const terminalWorkspaces = readTerminalWorkspaces(
        options.terminalRegistry,
        principal,
        options.terminalOwnerId,
      );
      const providers = options.providerRegistry
        ? await readRegisteredProviders(options.providerRegistry, principal)
        : await readProviders(options.agentCredentials, principal, options.providerIds);
      const activeThreads = await readActiveThreads(options.threads, principal);
      const attentionThreads = await readAttentionThreads(options.threads, principal);
      const projectSummaryTimeoutMs = Math.min(
        Math.max(options.projectSummaryTimeoutMs ?? DEFAULT_PROJECT_SUMMARY_TIMEOUT_MS, 10),
        MAX_PROJECT_SUMMARY_TIMEOUT_MS,
      );
      const projectRead = await readProjects(options.projects, principal, projectSummaryTimeoutMs);
      const previewSessions = readPreviewSessions(options.previews, principal, summaryOptions);
      const threadsEnabled = Boolean(options.threads);
      const workspaceEnabled = threadsEnabled && options.capabilities?.workspace === true;
      const approvalsEnabled = threadsEnabled && options.capabilities?.approvals === true;
      const reviewEnabled = options.capabilities?.review === true;
      const previewEnabled = Boolean(options.previews) && options.capabilities?.preview === true;
      const filesEnabled = options.capabilities?.files === true && canReadOwnerResource(principal, options.filesOwnerId);
      const sourceControlEnabled = options.capabilities?.sourceControl === true;
      const terminalEnabled = Boolean(options.terminalRegistry) &&
        canReadTerminalWorkspaces(principal, options.terminalOwnerId);
      const projectWorkspaceConfigured = options.capabilities?.projectWorkspace === true;
      const projectWorkspaceEnabled = projectWorkspaceConfigured && projectRead.available;
      const projectWorkspaceReason = !projectRead.available
        ? "Project workspace is temporarily unavailable"
        : undefined;

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
          capability({
            id: "codingAgentsSameThreadTurns",
            enabled: options.capabilities?.sameThreadTurns === true,
          }),
          capability({ id: "codingAgentsApprovals", enabled: approvalsEnabled }),
          capability({ id: "codingAgentsReview", enabled: reviewEnabled }),
          capability({ id: "codingAgentsPreview", enabled: previewEnabled }),
          capability({ id: "codingAgentsFiles", enabled: filesEnabled }),
          capability({ id: "codingAgentsSourceControl", enabled: sourceControlEnabled }),
          capability({ id: "codingAgentsNativeMobileTerminal", enabled: terminalEnabled }),
          ...(projectWorkspaceConfigured
            ? [
                capability({
                  id: "codingAgentsProjectWorkspace",
                  enabled: projectWorkspaceEnabled,
                  reason: projectWorkspaceReason,
                }),
                capability({
                  id: "codingAgentsConversationView",
                  enabled: projectWorkspaceEnabled
                    && options.capabilities?.conversationView === true,
                  reason: projectWorkspaceReason,
                }),
                capability({
                  id: "codingAgentsKanbanView",
                  enabled: projectWorkspaceEnabled
                    && options.capabilities?.kanbanView === true,
                  reason: projectWorkspaceReason,
                }),
              ]
            : []),
        ],
        providers,
        projects: projectRead.page,
        activeThreads,
        attentionThreads,
        terminalWorkspaces: await terminalWorkspaces,
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
