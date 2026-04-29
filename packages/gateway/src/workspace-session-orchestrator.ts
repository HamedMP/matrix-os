import { randomUUID } from "node:crypto";
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
import type { WorkspaceEventPublisher } from "./workspace-event-publisher.js";

type WorktreeManager = Pick<ReturnType<typeof createWorktreeManager>, "listWorktrees">;
type AgentSessionManager = Pick<
  ReturnType<typeof createAgentSessionManager>,
  "startSession" | "listSessions" | "getSession" | "sendInput" | "killSession"
>;
type AgentSandbox = Pick<ReturnType<typeof createAgentSandbox>, "preflight">;
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

async function resolveCodexSandbox(options: {
  agentSandbox: AgentSandbox;
  request: StartWorkspaceSessionRequest;
  sessionId: string;
  worktree: WorktreeRecord;
}): Promise<{ ok: true; sandbox?: AgentLaunchSandbox } | Failure> {
  const preflight = await options.agentSandbox.preflight({
    agent: "codex",
    sessionId: options.sessionId,
    worktreePath: options.worktree.path,
    adminOverride: options.request.adminSandboxOverride,
  });
  if (!preflight.ok) {
    return {
      ok: false,
      status: preflight.status,
      error: preflight.error,
      sandboxStatus: preflight.sandboxStatus,
    };
  }
  return { ok: true, sandbox: preflight.sandbox };
}

export function createWorkspaceSessionOrchestrator(options: {
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

  return {
    async startSession(input: StartWorkspaceSessionInput): Promise<
      { ok: true; status: number; session: WorkspaceSessionView } | Failure
    > {
      const sessionId = input.request.sessionId ?? idGenerator();
      let sandbox: AgentLaunchSandbox | undefined;

      if (input.request.agent === "codex") {
        if (!input.request.projectSlug || !input.request.worktreeId) {
          return failure(400, "sandbox_unavailable", "Agent sandbox is unavailable");
        }
        const worktree = await resolveRequestedWorktree(
          options.worktreeManager,
          input.request.projectSlug,
          input.request.worktreeId,
        );
        if (!worktree.ok) return worktree;
        const preflight = await resolveCodexSandbox({
          agentSandbox: options.agentSandbox,
          request: input.request,
          sessionId,
          worktree: worktree.worktree,
        });
        if (!preflight.ok) return preflight;
        sandbox = preflight.sandbox;
      }

      const result = await options.agentSessionManager.startSession({
        ...input.request,
        sessionId,
        ownerId: input.ownerScope.id,
        sandbox,
      });
      if (!result.ok) return result;

      await publishSessionStarted(result.session);
      return result;
    },

    async listSessions(input: ListSessionsInput = {}) {
      return options.agentSessionManager.listSessions(input);
    },

    async getSession(sessionId: string) {
      return options.agentSessionManager.getSession(sessionId);
    },

    async sendInput(sessionId: string, input: string) {
      return options.agentSessionManager.sendInput(sessionId, input);
    },

    async attachSession(sessionId: string, mode: SessionAttachMode) {
      const session = await options.agentSessionManager.getSession(sessionId);
      if (!session.ok) return session;
      return options.sessionRuntimeBridge.registerSession(session.session, { mode });
    },

    async stopSession(sessionId: string) {
      const result = await options.agentSessionManager.killSession(sessionId);
      if (!result.ok) return result;
      await publishSessionStopped(result.session);
      return result;
    },

    async recoverSessions() {
      return options.agentSessionManager.listSessions({ status: "running" });
    },
  };
}

export type WorkspaceSessionOrchestrator = ReturnType<typeof createWorkspaceSessionOrchestrator>;
