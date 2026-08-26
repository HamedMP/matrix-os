import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentAttachment, AgentModelOption } from "@matrix-os/contracts";
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

const ROOT_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1_000;
const ROOT_WORKSPACE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const ROOT_SESSION_PAGE_LIMIT = 100;
const ROOT_SESSION_PAGE_CAP = 20;
const ACTIVE_ROOT_SESSION_STATUSES = new Set(["starting", "running", "idle", "waiting"]);

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
  model?: string;
  modelOptions?: AgentModelOption[];
  mode?: "default" | "plan" | "review" | "full_access";
  approvalPolicy?: "untrusted" | "on_request" | "on_failure" | "never";
  sandboxMode?: "read_only" | "workspace_write" | "full_access";
  runtimePreference?: "zellij";
  adminSandboxOverride?: boolean;
  /** Gateway-internal execution root for a Root Chat. Never accepted by public routes. */
  workspaceRoot?: string;
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
  ownerScope: OwnerScope,
  projectSlug: string,
  worktreeId: string,
): Promise<{ ok: true; worktree: WorktreeRecord } | Failure> {
  const listed = await worktreeManager.listWorktrees(projectSlug, ownerScope);
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
    const resolved = await resolveRequestedWorktree(worktreeManager, ownerScope, projectSlug, worktreeId);
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

function errnoIs(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function prepareRootChatWorkspace(homePath: string, sessionId: string): Promise<string> {
  const canonicalHome = await realpath(resolve(homePath));
  const root = join(canonicalHome, "temporary", "root-chat-workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Root Chat workspace root is invalid");
  }
  const workspace = join(root, sessionId);
  await mkdir(workspace, { mode: 0o700 });
  const workspaceStats = await lstat(workspace);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink() || await realpath(workspace) !== workspace) {
    throw new Error("Root Chat workspace is invalid");
  }
  return workspace;
}

async function cleanupRootChatWorkspace(homePath: string, sessionId: string): Promise<void> {
  const canonicalHome = await realpath(resolve(homePath));
  const root = join(canonicalHome, "temporary", "root-chat-workspaces");
  try {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || await realpath(root) !== root) return;
    const workspace = join(root, sessionId);
    const workspaceStats = await lstat(workspace);
    if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) return;
    if (await realpath(workspace) !== workspace) return;
    await rm(workspace, { recursive: true, force: true });
  } catch (error: unknown) {
    if (!errnoIs(error, "ENOENT")) throw error;
  }
}

export async function cleanupExpiredRootChatWorkspaces(
  homePath: string,
  activeSessionIds: ReadonlySet<string>,
  options: { nowMs?: number; ttlMs?: number } = {},
): Promise<void> {
  const canonicalHome = await realpath(resolve(homePath));
  const root = join(canonicalHome, "temporary", "root-chat-workspaces");
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? ROOT_WORKSPACE_TTL_MS;
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || await realpath(root) !== root) return;
    directory = await opendir(root);
  } catch (error: unknown) {
    if (errnoIs(error, "ENOENT")) return;
    throw error;
  }

  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || activeSessionIds.has(entry.name)) continue;
    const workspace = join(root, entry.name);
    try {
      const stats = await lstat(workspace);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      if (await realpath(workspace) !== workspace) continue;
      if (nowMs - stats.mtimeMs <= ttlMs) continue;
      await rm(workspace, { recursive: true, force: true });
    } catch (error: unknown) {
      if (!errnoIs(error, "ENOENT")) {
        console.warn("[workspace-session-orchestrator] Root Chat workspace cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
  }
}

export function createWorkspaceSessionOrchestrator(options: {
  projectManager: ProjectManager;
  worktreeManager: WorktreeManager;
  agentSessionManager: AgentSessionManager;
  agentSandbox: AgentSandbox;
  sessionRuntimeBridge: SessionRuntimeBridge;
  eventPublisher?: Pick<WorkspaceEventPublisher, "publishSessionStarted" | "publishSessionStopped">;
  idGenerator?: () => string;
  homePath?: string;
  prepareRootChatWorkspace?: (sessionId: string) => Promise<string>;
  cleanupRootChatWorkspace?: (sessionId: string) => Promise<void>;
  sweepRootChatWorkspaces?: (activeSessionIds: ReadonlySet<string>) => Promise<void>;
  rootWorkspaceSweepIntervalMs?: number;
}) {
  const idGenerator = options.idGenerator ?? (() => `sess_${randomUUID()}`);
  const prepareRootWorkspace = options.prepareRootChatWorkspace
    ?? (options.homePath ? (sessionId: string) => prepareRootChatWorkspace(options.homePath!, sessionId) : undefined);
  const cleanupRootWorkspace = options.cleanupRootChatWorkspace
    ?? (options.homePath ? (sessionId: string) => cleanupRootChatWorkspace(options.homePath!, sessionId) : undefined);
  const sweepRootWorkspaces = options.sweepRootChatWorkspaces
    ?? (options.homePath
      ? (activeSessionIds: ReadonlySet<string>) => cleanupExpiredRootChatWorkspaces(options.homePath!, activeSessionIds)
      : undefined);
  let sweepTask: Promise<void> | null = null;
  const startSweep = () => {
    if (!sweepRootWorkspaces || sweepTask) return;
    sweepTask = (async () => {
      const activeSessionIds = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < ROOT_SESSION_PAGE_CAP; pageIndex += 1) {
        const listed = await options.agentSessionManager.listSessions({
          limit: ROOT_SESSION_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        if (!listed.ok) return;
        for (const session of listed.sessions) {
          if (
            session.kind === "agent"
            && !session.projectSlug
            && ACTIVE_ROOT_SESSION_STATUSES.has(session.runtime.status)
          ) activeSessionIds.add(session.id);
        }
        if (!listed.nextCursor) {
          await sweepRootWorkspaces(activeSessionIds);
          return;
        }
        cursor = listed.nextCursor;
      }
      console.warn("[workspace-session-orchestrator] Root Chat workspace sweep skipped: session page cap reached");
    })().catch((error: unknown) => {
      console.warn("[workspace-session-orchestrator] Root Chat workspace sweep failed:",
        error instanceof Error ? error.name : "UnknownError");
    }).finally(() => {
      sweepTask = null;
    });
  };
  const sweepTimer = sweepRootWorkspaces
    ? setInterval(startSweep, options.rootWorkspaceSweepIntervalMs ?? ROOT_WORKSPACE_SWEEP_INTERVAL_MS)
    : undefined;
  sweepTimer?.unref?.();

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
      let ownsRootWorkspace = false;

      if (request.agent === "codex" || request.agent === "claude") {
        let workspacePath: string;
        let resolvedWorktreeId: string | undefined;
        if (request.projectSlug) {
          const workspaceRoot = await resolveAgentWorkspaceRoot(
            options.projectManager,
            options.worktreeManager,
            input.ownerScope,
            request.projectSlug,
            request.worktreeId,
          );
          if (!workspaceRoot.ok) return workspaceRoot;
          workspacePath = workspaceRoot.path;
          resolvedWorktreeId = workspaceRoot.worktreeId;
        } else {
          if (!prepareRootWorkspace) {
            return failure(503, "sandbox_unavailable", "Agent sandbox is unavailable");
          }
          try {
            workspacePath = await prepareRootWorkspace(sessionId);
          } catch (error: unknown) {
            console.warn(
              "[workspace-session-orchestrator] Root Chat workspace setup failed:",
              error instanceof Error ? error.name : "UnknownError",
            );
            return failure(503, "sandbox_unavailable", "Agent sandbox is unavailable");
          }
        }
        ownsRootWorkspace = !request.projectSlug;
        effectiveRequest = {
          ...request,
          ...(resolvedWorktreeId ? { worktreeId: resolvedWorktreeId } : {}),
          ...(!request.projectSlug ? { workspaceRoot: workspacePath } : {}),
        };
        const preflight = await resolveAgentSandbox({
          agentSandbox: options.agentSandbox,
          agent: request.agent,
          request: effectiveRequest,
          sessionId,
          workspacePath,
        });
        if (!preflight.ok) {
          if (ownsRootWorkspace) await cleanupRootWorkspace?.(sessionId);
          return preflight;
        }
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
        if (ownsRootWorkspace) await cleanupRootWorkspace?.(sessionId);
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
      const existing = await options.agentSessionManager.getSession(sessionId);
      const result = await options.agentSessionManager.killSession(sessionId);
      if (!result.ok) return result;
      await cleanupSessionScratch(sessionId);
      if (existing.ok && existing.session.kind === "agent" && !existing.session.projectSlug) {
        await cleanupRootWorkspace?.(sessionId);
      }
      await publishSessionStopped(result.session);
      return result;
    },

    async recoverSessions() {
      return options.agentSessionManager.listSessions({ status: "running" });
    },

    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      await sweepTask;
    },
  };
}

export type WorkspaceSessionOrchestrator = ReturnType<typeof createWorkspaceSessionOrchestrator>;
