import { randomUUID } from "node:crypto";
import type { AgentAttachment } from "@matrix-os/contracts";
import type {
  WorkspaceSessionView,
  createAgentSessionManager,
} from "./agent-session-manager.js";
import type { AgentLaunchSandbox, SupportedAgent } from "./agent-launcher.js";
import type { WorkspaceError } from "./project-manager.js";
import type { OwnerScope } from "./state-ops.js";
import type { createAgentSandbox } from "./agent-sandbox.js";
import type { createSessionRuntimeBridge } from "./session-runtime-bridge.js";
import type { createWorktreeManager, WorktreeRecord } from "./worktree-manager.js";
import type { createProjectManager } from "./project-manager.js";
import type { WorkspaceEventPublisher } from "./workspace-event-publisher.js";

type WorktreeManager = Pick<
  ReturnType<typeof createWorktreeManager>,
  "listWorktrees"
>;
type ProjectManager = Pick<ReturnType<typeof createProjectManager>, "getProject">;
type AgentSessionManager = Pick<
  ReturnType<typeof createAgentSessionManager>,
  "startSession" | "listSessions" | "getSession" | "sendInput" | "killSession"
>;
type AgentSandbox = Pick<ReturnType<typeof createAgentSandbox>, "preflight" | "cleanup">;
type SessionRuntimeBridge = Pick<ReturnType<typeof createSessionRuntimeBridge>, "registerSession">;
type SessionAttachMode = "observe" | "owner";
type ListSessionsInput = Parameters<AgentSessionManager["listSessions"]>[0];

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
  holderId?: string;
  sandboxStatus?: unknown;
};

export interface StartWorkspaceSessionRequest {
  sessionId?: string;
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  kind: "shell" | "agent";
  agent?: SupportedAgent;
  prompt?: string;
  attachments?: AgentAttachment[];
  mode?: "default" | "plan" | "review" | "full_access";
  approvalPolicy?: "untrusted" | "on_request" | "on_failure" | "never";
  sandboxMode?: "read_only" | "workspace_write" | "full_access";
  runtimePreference?: "zellij";
  adminSandboxOverride?: boolean;
}

export interface StartWorkspaceSessionInput {
  ownerScope: OwnerScope;
  request: StartWorkspaceSessionRequest;
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

async function resolveRequestedWorktree(
  worktreeManager: WorktreeManager,
  projectSlug: string,
  worktreeId: string,
): Promise<{ ok: true; worktree: WorktreeRecord } | Failure> {
  const listed = await worktreeManager.listWorktrees(projectSlug);
  if (!listed.ok) return listed;
  const worktree = listed.worktrees.find((entry) => entry.id === worktreeId);
  return worktree ? { ok: true, worktree } : failure(404, "not_found", "Worktree was not found");
}

async function resolveAgentWorkspaceRoot(
  projectManager: ProjectManager,
  worktreeManager: WorktreeManager,
  ownerScope: OwnerScope,
  projectSlug: string,
  worktreeId: string | undefined,
): Promise<{ ok: true; path: string; worktreeId?: string } | Failure> {
  if (worktreeId) {
    const resolved = await resolveRequestedWorktree(worktreeManager, projectSlug, worktreeId);
    return resolved.ok
      ? { ok: true, path: resolved.worktree.path, worktreeId: resolved.worktree.id }
      : resolved;
  }
  const project = await projectManager.getProject(projectSlug);
  if (!project.ok) {
    return project.status >= 500
      ? failure(503, "sandbox_unavailable", "Agent sandbox is unavailable")
      : failure(404, "not_found", "Project was not found");
  }
  // A project checkout may only host sessions for its persisted owner; a
  // mismatched scope reads as not-found so foreign owners learn nothing.
  const projectOwner = project.project.ownerScope;
  if (projectOwner.type !== ownerScope.type || projectOwner.id !== ownerScope.id) {
    return failure(404, "not_found", "Project was not found");
  }
  return { ok: true, path: project.project.localPath };
}

function toLaunchApprovalPolicy(
  policy?: StartWorkspaceSessionRequest["approvalPolicy"],
): "untrusted" | "on-request" | "on-failure" | "never" | undefined {
  if (policy === "on_request") return "on-request";
  if (policy === "on_failure") return "on-failure";
  return policy;
}

async function resolveAgentSandbox(options: {
  agentSandbox: AgentSandbox;
  agent: Extract<SupportedAgent, "claude" | "codex">;
  request: StartWorkspaceSessionRequest;
  sessionId: string;
  workspacePath: string;
}): Promise<{ ok: true; sandbox?: AgentLaunchSandbox } | Failure> {
  const preflight = await options.agentSandbox.preflight({
    agent: options.agent,
    sessionId: options.sessionId,
    worktreePath: options.workspacePath,
    adminOverride: options.request.adminSandboxOverride,
    mode: options.request.mode,
    approvalPolicy: toLaunchApprovalPolicy(options.request.approvalPolicy) ??
      (options.agent === "claude" ? "on-request" : "never"),
    sandboxMode: options.request.sandboxMode ?? "workspace_write",
  });
  if (!preflight.ok) {
    return {
      ok: false,
      status: preflight.status,
      error: preflight.error,
      sandboxStatus: preflight.sandboxStatus,
    };
  }
  if (
    preflight.sandbox?.enabled &&
    (options.request.sandboxMode === "read_only" ||
      (options.agent === "claude" && (options.request.mode === "plan" || options.request.mode === "review")))
  ) {
    return { ok: true, sandbox: { ...preflight.sandbox, mode: "read-only", writableRoots: [] } };
  }
  if (options.request.sandboxMode === "full_access" && preflight.sandbox?.enabled) {
    return { ok: true, sandbox: { ...preflight.sandbox, mode: "danger-full-access", writableRoots: [] } };
  }
  return {
    ok: true,
    sandbox: preflight.sandbox?.enabled
      ? { ...preflight.sandbox, mode: "workspace-write" }
      : preflight.sandbox,
  };
}

export function createWorkspaceSessionOrchestrator(options: {
  projectManager: ProjectManager;
  worktreeManager: WorktreeManager;
  agentSessionManager: AgentSessionManager;
  agentSandbox: AgentSandbox;
  sessionRuntimeBridge: SessionRuntimeBridge;
  eventPublisher?: Pick<WorkspaceEventPublisher, "publishSessionStarted" | "publishSessionStopped">;
  idGenerator?: () => string;
}) {
  const idGenerator = options.idGenerator ?? (() => `sess_${randomUUID()}`);

  async function publishSessionStarted(session: WorkspaceSessionView): Promise<void> {
    try {
      await options.eventPublisher?.publishSessionStarted(session);
    } catch (err: unknown) {
      console.warn(
        "[workspace-session-orchestrator] Failed to publish session start event:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function publishSessionStopped(session: WorkspaceSessionView): Promise<void> {
    try {
      await options.eventPublisher?.publishSessionStopped(session);
    } catch (err: unknown) {
      console.warn(
        "[workspace-session-orchestrator] Failed to publish session stop event:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function cleanupSessionScratch(sessionId: string): Promise<void> {
    try {
      await options.agentSandbox.cleanup({ sessionId });
    } catch (err: unknown) {
      console.warn(
        "[workspace-session-orchestrator] Failed to clean session scratch state:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    async startSession(input: StartWorkspaceSessionInput): Promise<
      { ok: true; status: number; session: WorkspaceSessionView } | Failure
    > {
      const request: StartWorkspaceSessionRequest =
        input.request.kind === "agent" && input.request.agent === "claude"
        ? { ...input.request, approvalPolicy: input.request.approvalPolicy ?? "on_request" }
        : input.request;
      const sessionId = request.sessionId ?? idGenerator();
      let sandbox: AgentLaunchSandbox | undefined;
      let effectiveRequest = request;

      if (request.agent === "codex" || request.agent === "claude") {
        if (!request.projectSlug) {
          return failure(400, "sandbox_unavailable", "Agent sandbox is unavailable");
        }
        const workspaceRoot = await resolveAgentWorkspaceRoot(
          options.projectManager,
          options.worktreeManager,
          input.ownerScope,
          request.projectSlug,
          request.worktreeId,
        );
        if (!workspaceRoot.ok) return workspaceRoot;
        effectiveRequest = workspaceRoot.worktreeId
          ? { ...request, worktreeId: workspaceRoot.worktreeId }
          : request;
        const preflight = await resolveAgentSandbox({
          agentSandbox: options.agentSandbox,
          agent: request.agent,
          request: effectiveRequest,
          sessionId,
          workspacePath: workspaceRoot.path,
        });
        if (!preflight.ok) return preflight;
        sandbox = preflight.sandbox;
      }

      const result = await options.agentSessionManager.startSession({
        ...effectiveRequest,
        sessionId,
        ownerId: input.ownerScope.id,
        sandbox,
      });
      if (!result.ok) {
        if (sandbox) await cleanupSessionScratch(sessionId);
        return result;
      }

      await publishSessionStarted(result.session);
      return result;
    },

    async listSessions(input: ListSessionsInput = {}) {
      return options.agentSessionManager.listSessions(input);
    },

    async getSession(sessionId: string) {
      return options.agentSessionManager.getSession(sessionId);
    },

    async sendInput(sessionId: string, input: string, signal?: AbortSignal) {
      return options.agentSessionManager.sendInput(sessionId, input, signal);
    },

    async attachSession(sessionId: string, mode: SessionAttachMode) {
      const session = await options.agentSessionManager.getSession(sessionId);
      if (!session.ok) return session;
      return options.sessionRuntimeBridge.registerSession(session.session, { mode });
    },

    async stopSession(sessionId: string) {
      const result = await options.agentSessionManager.killSession(sessionId);
      if (!result.ok) return result;
      await cleanupSessionScratch(sessionId);
      await publishSessionStopped(result.session);
      return result;
    },

    async recoverSessions() {
      return options.agentSessionManager.listSessions({ status: "running" });
    },
  };
}

export type WorkspaceSessionOrchestrator = ReturnType<typeof createWorkspaceSessionOrchestrator>;
