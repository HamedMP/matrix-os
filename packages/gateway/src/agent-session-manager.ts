import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  SupportedAgentSchema,
  type AgentLaunchSandbox,
  type SupportedAgent,
} from "./agent-launcher.js";
import { PROJECT_SLUG_REGEX, type ProjectConfig, type WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile } from "./state-ops.js";
import type { createAgentLauncher } from "./agent-launcher.js";
import type { createWorktreeManager, WorktreeRecord } from "./worktree-manager.js";
import type { createZellijRuntime } from "./zellij-runtime.js";

export type SessionKind = "shell" | "agent";
export type RuntimeStatus = "starting" | "running" | "idle" | "waiting" | "exited" | "failed" | "degraded";

export interface WorkspaceSession {
  id: string;
  kind: SessionKind;
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  agent?: SupportedAgent;
  runtime: {
    type: "zellij" | "tmux" | "pty";
    status: RuntimeStatus;
    zellijSession?: string;
    zellijLayoutPath?: string;
    tmuxSession?: string;
    fallbackReason?: string;
  };
  terminalSessionId: string;
  transcriptPath: string;
  attachedClients: number;
  writeMode: "owner" | "takeover" | "closed";
  ownerId: string;
  startedAt: string;
  lastActivityAt: string;
  exitedAt?: string;
  exitCode?: number;
}

export type WorkspaceSessionView = WorkspaceSession & {
  nativeAttachCommand?: string[];
  observeCommand?: string[];
};

type WorktreeManager = Pick<
  ReturnType<typeof createWorktreeManager>,
  "listWorktrees" | "acquireLease" | "releaseLease"
>;
type AgentLauncher = Pick<ReturnType<typeof createAgentLauncher>, "buildLaunch">;
type ZellijRuntime = Pick<
  ReturnType<typeof createZellijRuntime>,
  "start" | "attachCommand" | "observeCommand" | "kill" | "health"
>;

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
  holderId?: string;
};

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const TaskIdSchema = z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/);
const SlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const WorktreeIdSchema = z.string().regex(/^wt_[a-z0-9]{12,40}$/);
const AgentSandboxSchema = z.object({
  enabled: z.boolean(),
  writableRoots: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
  adminOverride: z.boolean().optional(),
}).strict();
const StartSessionSchema = z.object({
  kind: z.enum(["shell", "agent"]),
  ownerId: z.string().trim().min(1).max(200),
  projectSlug: SlugSchema.optional(),
  taskId: TaskIdSchema.optional(),
  worktreeId: WorktreeIdSchema.optional(),
  pr: z.number().int().positive().optional(),
  agent: SupportedAgentSchema.optional(),
  prompt: z.string().max(100_000).optional(),
  runtimePreference: z.enum(["zellij"]).optional(),
  sandbox: AgentSandboxSchema.optional(),
});
const ListSessionsSchema = z.object({
  projectSlug: SlugSchema.optional(),
  taskId: TaskIdSchema.optional(),
  pr: z.number().int().positive().optional(),
  status: z.enum(["starting", "running", "idle", "waiting", "exited", "failed", "degraded"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
const SessionInputSchema = z.string().min(1).max(64 * 1024);

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(status: number, code: string, message: string, holderId?: string): Failure {
  return { ok: false, status, error: { code, message }, holderId };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function sessionPath(homePath: string, sessionId: string): string {
  return join(homePath, "system", "sessions", `${sessionId}.json`);
}

async function readProject(homePath: string, projectSlug: string): Promise<ProjectConfig | null> {
  try {
    return await readJsonFile<ProjectConfig>(join(homePath, "projects", projectSlug, "config.json"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readSession(homePath: string, sessionId: string): Promise<WorkspaceSession | null> {
  try {
    return await readJsonFile<WorkspaceSession>(sessionPath(homePath, sessionId));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeSession(homePath: string, session: WorkspaceSession): Promise<void> {
  await atomicWriteJson(sessionPath(homePath, session.id), session);
}

function isActive(session: WorkspaceSession): boolean {
  return ["starting", "running", "idle", "waiting"].includes(session.runtime.status);
}

function decorateSession(session: WorkspaceSession, runtime: ZellijRuntime): WorkspaceSessionView {
  if (session.runtime.type !== "zellij") return session;
  return {
    ...session,
    nativeAttachCommand: runtime.attachCommand(session.id),
    observeCommand: runtime.observeCommand(session.id),
  };
}

function sanitizeStartupInput(input: unknown):
  | { ok: true; value: z.infer<typeof StartSessionSchema> }
  | Failure {
  const parsed = StartSessionSchema.safeParse(input);
  if (!parsed.success) {
    return failure(400, "invalid_session_request", "Session request is invalid");
  }
  if (parsed.data.kind === "agent" && !parsed.data.agent) {
    return failure(400, "invalid_session_request", "Agent sessions require an agent");
  }
  if (parsed.data.kind === "shell" && parsed.data.agent) {
    return failure(400, "invalid_session_request", "Shell sessions cannot include an agent");
  }
  if (parsed.data.worktreeId && !parsed.data.projectSlug) {
    return failure(400, "invalid_session_request", "Worktree sessions require a project");
  }
  return { ok: true, value: parsed.data };
}

async function readAllSessions(homePath: string): Promise<WorkspaceSession[]> {
  const dir = join(homePath, "system", "sessions");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const sessions: WorkspaceSession[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.slice(0, -".json".length);
    if (!SessionIdSchema.safeParse(sessionId).success) continue;
    sessions.push(await readJsonFile<WorkspaceSession>(join(dir, entry.name)));
  }
  return sessions;
}

async function resolveWorktree(
  worktreeManager: WorktreeManager,
  projectSlug: string,
  worktreeId: string,
): Promise<WorktreeRecord | null> {
  const listed = await worktreeManager.listWorktrees(projectSlug);
  if (!listed.ok) return null;
  return listed.worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
}

export function createAgentSessionManager(options: {
  homePath: string;
  worktreeManager: WorktreeManager;
  agentLauncher: AgentLauncher;
  zellijRuntime: ZellijRuntime;
  inputWriter?: (sessionId: string, input: string) => Promise<void>;
  now?: () => string;
  idGenerator?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const idGenerator = options.idGenerator ?? (() => `sess_${randomUUID()}`);

  return {
    async startSession(input: unknown): Promise<
      { ok: true; status: 201; session: WorkspaceSessionView } | Failure
    > {
      const parsed = sanitizeStartupInput(input);
      if (!parsed.ok) return parsed;
      const request = parsed.value;
      const sessionId = idGenerator();
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(500, "session_id_invalid", "Session could not be created");
      }

      let cwd = homePath;
      let worktree: WorktreeRecord | null = null;
      if (request.projectSlug) {
        const project = await readProject(homePath, request.projectSlug);
        if (!project) return failure(404, "not_found", "Project was not found");
        cwd = project.localPath;
      }
      if (request.projectSlug && request.worktreeId) {
        worktree = await resolveWorktree(options.worktreeManager, request.projectSlug, request.worktreeId);
        if (!worktree || !await pathExists(worktree.path)) {
          return failure(404, "not_found", "Worktree was not found");
        }
        cwd = worktree.path;
        const lease = await options.worktreeManager.acquireLease({
          projectSlug: request.projectSlug,
          worktreeId: request.worktreeId,
          holderType: "session",
          holderId: sessionId,
        });
        if (!lease.ok) {
          const holderId = "holderId" in lease ? lease.holderId : undefined;
          return failure(lease.status, "worktree_locked", "Worktree is locked", holderId);
        }
      }

      const startedAt = nowIso(options.now);
      let launch;
      try {
        launch = request.kind === "agent"
          ? options.agentLauncher.buildLaunch({
            agent: request.agent!,
            cwd,
            prompt: request.prompt,
            sandbox: request.sandbox,
          })
          : { command: "bash", args: [], cwd, env: {} };
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn("[agent-session-manager] Launch preflight failed:", err.message);
        }
        if (request.projectSlug && request.worktreeId) {
          await options.worktreeManager.releaseLease({
            projectSlug: request.projectSlug,
            worktreeId: request.worktreeId,
            holderId: sessionId,
          });
        }
        return failure(400, "sandbox_unavailable", "Agent sandbox is unavailable");
      }

      let runtimeStart;
      try {
        runtimeStart = await options.zellijRuntime.start({ sessionId, launch });
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn("[agent-session-manager] Runtime start failed:", err.message);
        }
        if (request.projectSlug && request.worktreeId) {
          await options.worktreeManager.releaseLease({
            projectSlug: request.projectSlug,
            worktreeId: request.worktreeId,
            holderId: sessionId,
          });
        }
        return failure(503, "runtime_unavailable", "Session runtime is unavailable");
      }

      const session: WorkspaceSession = {
        id: sessionId,
        kind: request.kind,
        projectSlug: request.projectSlug,
        taskId: request.taskId,
        worktreeId: request.worktreeId,
        pr: request.pr,
        agent: request.agent,
        runtime: {
          type: "zellij",
          status: runtimeStart.status,
          zellijSession: runtimeStart.sessionName,
          zellijLayoutPath: runtimeStart.layoutPath,
        },
        terminalSessionId: `term_${sessionId}`,
        transcriptPath: join(homePath, "system", "session-output", `${sessionId}.jsonl`),
        attachedClients: 0,
        writeMode: "owner",
        ownerId: request.ownerId,
        startedAt,
        lastActivityAt: startedAt,
      };
      await writeSession(homePath, session);
      return { ok: true, status: 201, session: decorateSession(session, options.zellijRuntime) };
    },

    async getSession(sessionId: string): Promise<{ ok: true; session: WorkspaceSessionView } | Failure> {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const session = await readSession(homePath, sessionId);
      if (!session) return failure(404, "not_found", "Session was not found");
      return { ok: true, session: decorateSession(session, options.zellijRuntime) };
    },

    async listSessions(input: unknown = {}): Promise<
      { ok: true; sessions: WorkspaceSessionView[]; nextCursor: null } | Failure
    > {
      const parsed = ListSessionsSchema.safeParse(input);
      if (!parsed.success) {
        return failure(400, "invalid_session_query", "Session query is invalid");
      }
      const query = parsed.data;
      const limit = query.limit ?? 100;
      const sessions = (await readAllSessions(homePath))
        .filter((session) => !query.projectSlug || session.projectSlug === query.projectSlug)
        .filter((session) => !query.taskId || session.taskId === query.taskId)
        .filter((session) => typeof query.pr !== "number" || session.pr === query.pr)
        .filter((session) => !query.status || session.runtime.status === query.status)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .slice(0, limit)
        .map((session) => decorateSession(session, options.zellijRuntime));
      return { ok: true, sessions, nextCursor: null };
    },

    async sendInput(sessionId: string, input: string): Promise<{ ok: true; session: WorkspaceSessionView } | Failure> {
      if (!SessionIdSchema.safeParse(sessionId).success || !SessionInputSchema.safeParse(input).success) {
        return failure(400, "invalid_session_input", "Session input is invalid");
      }
      const session = await readSession(homePath, sessionId);
      if (!session) return failure(404, "not_found", "Session was not found");
      if (session.writeMode === "closed" || session.runtime.status === "exited" || session.runtime.status === "failed") {
        return failure(409, "session_closed", "Session is closed");
      }
      if (!options.inputWriter) {
        return failure(503, "runtime_unavailable", "Session runtime is unavailable");
      }
      try {
        await options.inputWriter(sessionId, input);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn("[agent-session-manager] Failed to send session input:", err.message);
        }
        return failure(502, "session_send_failed", "Session input could not be sent");
      }
      const updated = { ...session, lastActivityAt: nowIso(options.now) };
      await writeSession(homePath, updated);
      return { ok: true, session: decorateSession(updated, options.zellijRuntime) };
    },

    async killSession(sessionId: string): Promise<{ ok: true; session: WorkspaceSessionView } | Failure> {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const session = await readSession(homePath, sessionId);
      if (!session) return failure(404, "not_found", "Session was not found");
      try {
        await options.zellijRuntime.kill(sessionId);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn("[agent-session-manager] Runtime kill failed:", err.message);
        }
        return failure(503, "runtime_unavailable", "Session runtime is unavailable");
      }
      if (session.projectSlug && session.worktreeId) {
        const released = await options.worktreeManager.releaseLease({
          projectSlug: session.projectSlug,
          worktreeId: session.worktreeId,
          holderId: session.id,
        });
        if (!released.ok) {
          console.warn("[agent-session-manager] Worktree lease release failed:", released.error.code);
        }
      }
      const exitedAt = nowIso(options.now);
      const updated: WorkspaceSession = {
        ...session,
        runtime: { ...session.runtime, status: "exited" },
        writeMode: "closed",
        lastActivityAt: exitedAt,
        exitedAt,
      };
      await writeSession(homePath, updated);
      return { ok: true, session: decorateSession(updated, options.zellijRuntime) };
    },

    async reconcileStartup(): Promise<{ checked: number; degraded: number; releasedLeases: number }> {
      const sessions = await readAllSessions(homePath);
      let degraded = 0;
      for (const session of sessions) {
        if (!isActive(session) || session.runtime.type !== "zellij") continue;
        const health = await options.zellijRuntime.health();
        if (health.status !== "degraded") continue;
        degraded += 1;
        await writeSession(homePath, {
          ...session,
          runtime: {
            ...session.runtime,
            status: "degraded",
            fallbackReason: health.fallbackReason ?? "runtime_degraded",
          },
          lastActivityAt: nowIso(options.now),
        });
      }
      return { checked: sessions.length, degraded, releasedLeases: 0 };
    },
  };
}
