// Attachable session list: zellij sessions (GET /api/terminal/sessions ->
// { sessions: [{ name, status, ... }] }) merged with workspace records
// (GET /api/sessions -> { sessions: [{ id, runtime: { zellijSession? } }], nextCursor }).
// Only entries with a real zellij attach name exist here (L6).
import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import { SHELL_SESSION_CREATE_ATTEMPTS, twoWordShellSessionName } from "../lib/shell-session-names";
import {
  mergeAttachableSessions,
  type AttachableSession,
  type WorkspaceSessionDTO,
  type ZellijSessionDTO,
} from "../lib/session-merge";
import { useBoard } from "./board";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

export interface SessionCreateInput {
  kind: "shell" | "agent";
  agent?: "claude" | "codex" | "opencode" | "pi";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  prompt?: string;
}

const SUPPORTED_AGENTS = new Set(["claude", "codex", "opencode", "pi"]);

function sessionAgent(agent: string | undefined): SessionCreateInput["agent"] | undefined {
  return SUPPORTED_AGENTS.has(agent ?? "") ? (agent as SessionCreateInput["agent"]) : undefined;
}

export interface CreatedSession {
  sessionId: string;
  attachName: string | null;
}

interface SessionsState {
  sessions: AttachableSession[];
  aliasMap: Record<string, string>;
  loading: boolean;
  creating: boolean;
  error: AppErrorCategory | null;
  // A specific, user-facing reason the last create() failed (null when fine).
  createError: string | null;
  load(api: ApiClient): Promise<void>;
  create(api: ApiClient, input?: SessionCreateInput): Promise<CreatedSession | null>;
  kill(api: ApiClient, attachName: string): Promise<boolean>;
  restart(api: ApiClient, attachName: string): Promise<CreatedSession | null>;
  resolveAttachName(linkedSessionId: string | null): string | null;
}

// Map the gateway's safe error code (AppError.detail) to a specific reason so
// the user sees WHY a session couldn't start, not just a generic failure.
function describeSessionError(err: unknown): string {
  const detail = err instanceof AppError ? err.detail : undefined;
  switch (detail) {
    case "invalid_session_request":
      return "Your computer rejected the session request.";
    case "not_found":
      return "The project or worktree wasn't found on your computer.";
    case "worktree_locked":
      return "That worktree is already in use by another session.";
    case "sandbox_unavailable":
      return "The coding agent's sandbox isn't available. Check that the agent is connected.";
    case "runtime_unavailable":
      return "The session runtime (zellij) isn't available right now.";
    case "server_misconfigured":
      return "Your computer isn't fully set up for cloud sessions yet.";
    default:
      if (err instanceof AppError && err.category === "unauthorized") return "Your session expired. Sign in again.";
      if (err instanceof AppError && err.category === "offline") return "Can't reach your computer. Check your connection.";
      return "Couldn't start the session. Check that your computer and agent are connected.";
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

let loadSequence = 0;

function nextSessionName(): string {
  return twoWordShellSessionName();
}

function isSessionExistsError(err: unknown): boolean {
  return err instanceof AppError && err.detail === "session_exists";
}

async function createTerminalSessionWithRetries(api: ApiClient): Promise<{ name: string; response: { name?: unknown } }> {
  for (let attempt = 0; ; attempt += 1) {
    const name = nextSessionName();
    try {
      const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", { name });
      return { name, response };
    } catch (err: unknown) {
      if (isSessionExistsError(err) && attempt < SHELL_SESSION_CREATE_ATTEMPTS - 1) continue;
      throw err;
    }
  }
}

async function deleteAttachableSession(api: ApiClient, attachName: string): Promise<void> {
  await api.delete(`/api/terminal/sessions/${encodeURIComponent(attachName)}?force=1`);
}

async function deleteWorkspaceSession(api: ApiClient, sessionId: string): Promise<void> {
  await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

async function fetchMergedSessions(api: ApiClient): Promise<{
  sessions: AttachableSession[];
  aliasMap: Record<string, string>;
}> {
  const [zellijResponse, workspaceResponse] = await Promise.all([
    api.get<{ sessions: unknown }>("/api/terminal/sessions"),
    api.get<{ sessions: unknown; nextCursor: string | null }>("/api/sessions"),
  ]);
  return mergeAttachableSessions(
    asArray<ZellijSessionDTO>(zellijResponse.sessions),
    asArray<WorkspaceSessionDTO>(workspaceResponse.sessions),
  );
}

function mergeCreatedSessionState(
  state: Pick<SessionsState, "sessions" | "aliasMap">,
  merged: { sessions: AttachableSession[]; aliasMap: Record<string, string> },
  sessionId: string,
  directAttachName: string | null,
): { sessions: AttachableSession[]; aliasMap: Record<string, string>; attachName: string | null } {
  const attachName = merged.aliasMap[sessionId] ?? directAttachName;
  if (!attachName) return { sessions: state.sessions, aliasMap: state.aliasMap, attachName: null };
  const created = merged.sessions.find((session) => session.attachName === attachName) ?? null;
  const existingIndex = state.sessions.findIndex((session) => session.attachName === attachName);
  const sessions =
    created === null
      ? state.sessions
      : existingIndex >= 0
        ? state.sessions.map((session, index) => (index === existingIndex ? created : session))
        : [created, ...state.sessions];
  return {
    sessions,
    aliasMap: { ...state.aliasMap, [sessionId]: attachName },
    attachName,
  };
}

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: [],
  aliasMap: {},
  loading: false,
  creating: false,
  error: null,
  createError: null,

  load: async (api) => {
    const runtimeGeneration = captureRuntimeGeneration();
    const sequence = ++loadSequence;
    set({ loading: true, error: null });
    try {
      const merged = await fetchMergedSessions(api);
      if (sequence !== loadSequence || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      set({
        sessions: merged.sessions,
        aliasMap: merged.aliasMap,
        loading: false,
        error: null,
      });
    } catch (err: unknown) {
      if (sequence !== loadSequence || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.error("[sessions] Failed to load sessions:", err);
      set({
        loading: false,
        error: err instanceof AppError ? err.category : "server",
      });
    }
  },

  create: async (api, input) => {
    // A computer switch advances the runtime generation; a create that settles
    // afterwards belongs to the previous computer and must not commit results
    // (the transition already reset creating/error state).
    const runtimeGeneration = captureRuntimeGeneration();
    set({ creating: true, error: null, createError: null });
    try {
      if (!input) {
        const { name, response } = await createTerminalSessionWithRetries(api);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const attachName = typeof response.name === "string" && response.name.trim() ? response.name.trim() : name;
        const refreshSequence = loadSequence + 1;
        await get().load(api);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const refreshError = get().error;
        const created = get().sessions.find((session) => session.attachName === attachName) ?? {
          name: attachName,
          attachName,
          status: "active" as const,
          source: "zellij" as const,
        };
        set((state) => {
          const loadingPatch = refreshSequence === loadSequence && state.loading ? { loading: false } : {};
          return state.sessions.some((session) => session.attachName === created.attachName)
            ? { ...loadingPatch, creating: false, error: refreshError }
            : { sessions: [created, ...state.sessions], ...loadingPatch, creating: false, error: refreshError };
        });
        return { sessionId: attachName, attachName };
      }

      const res = await api.post<{
        session?: { id?: unknown; runtime?: { zellijSession?: unknown } | null };
      }>("/api/sessions", input);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
      const directAttachName =
        typeof res.session?.runtime?.zellijSession === "string"
          ? res.session.runtime.zellijSession
          : null;
      // Reload so the merged aliasMap resolves the new session's zellij name
      // (the attach target). Keep this snapshot local so a concurrent external
      // load cannot preempt the return value for the just-created session.
      const sequence = ++loadSequence;
      let merged: Awaited<ReturnType<typeof fetchMergedSessions>>;
      try {
        merged = await fetchMergedSessions(api);
      } catch (err: unknown) {
        // The cleanup delete would target the newly selected computer with the
        // old computer's session id; skip it and the error commit entirely.
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        if (sessionId) {
          await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`).catch((cleanupErr: unknown) => {
            console.warn(
              "[sessions] Failed to clean up created session after refresh failure:",
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            );
          });
        }
        console.error("[sessions] Failed to refresh sessions after create:", err);
        set({ creating: false, error: err instanceof AppError ? err.category : "server" });
        return null;
      }
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      if (sequence === loadSequence) {
        set({
          sessions: merged.sessions,
          aliasMap: merged.aliasMap,
          loading: false,
          creating: false,
          error: null,
          createError: null,
        });
      } else {
        set((state) => {
          const next =
            sessionId === null
              ? { sessions: state.sessions, aliasMap: state.aliasMap }
              : mergeCreatedSessionState(state, merged, sessionId, directAttachName);
          return {
            sessions: next.sessions,
            aliasMap: next.aliasMap,
            creating: false,
            error: null,
            createError: null,
          };
        });
      }
      if (!sessionId) return null;
      return {
        sessionId,
        attachName: merged.aliasMap[sessionId] ?? directAttachName,
      };
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      console.error("[sessions] Failed to create session:", err);
      set({
        creating: false,
        error: err instanceof AppError ? err.category : "server",
        createError: describeSessionError(err),
      });
      return null;
    }
  },

  kill: async (api, attachName) => {
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      await deleteAttachableSession(api, attachName);
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
      if (!(err instanceof AppError && err.category === "notFound")) {
        console.error("[sessions] Failed to kill session:", err);
        set({ error: err instanceof AppError ? err.category : "server" });
        return false;
      }
    }
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
    try {
      await get().load(api);
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
      console.error("[sessions] Failed to reload after kill:", err);
      set({ error: err instanceof AppError ? err.category : "server" });
    }
    return true;
  },

  restart: async (api, attachName) => {
    // Same invariant as create: a restart that settles after a computer switch
    // must not commit sessions or issue follow-up requests on the new runtime.
    const runtimeGeneration = captureRuntimeGeneration();
    set({ creating: true });
    try {
      const existing = get().sessions.find((session) => session.attachName === attachName) ?? null;
      try {
        await deleteAttachableSession(api, attachName);
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.category === "notFound")) throw err;
      }
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      if (existing?.source === "workspace" && existing.kind) {
        const input: SessionCreateInput = { kind: existing.kind };
        const agent = existing.kind === "agent" ? sessionAgent(existing.agent) : undefined;
        if (agent) input.agent = agent;
        if (existing.projectSlug) input.projectSlug = existing.projectSlug;
        if (existing.taskId) input.taskId = existing.taskId;
        if (existing.worktreeId) input.worktreeId = existing.worktreeId;
        const res = await api.post<{
          session?: { id?: unknown; runtime?: { zellijSession?: unknown } | null };
        }>("/api/sessions", input);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
        const directAttachName =
          typeof res.session?.runtime?.zellijSession === "string"
            ? res.session.runtime.zellijSession
            : null;
        if (!sessionId) {
          set({ creating: false, error: null });
          return null;
        }
        const sequence = ++loadSequence;
        let merged: Awaited<ReturnType<typeof fetchMergedSessions>>;
        try {
          merged = await fetchMergedSessions(api);
        } catch (err: unknown) {
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
          await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`).catch((cleanupErr: unknown) => {
            console.warn(
              "[sessions] Failed to clean up restarted session after refresh failure:",
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            );
          });
          console.error("[sessions] Failed to refresh sessions after restart:", err);
          set({ creating: false, error: err instanceof AppError ? err.category : "server" });
          return null;
        }
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        let nextAttachName = merged.aliasMap[sessionId] ?? directAttachName;
        if (sequence === loadSequence) {
          set({
            sessions: merged.sessions,
            aliasMap: merged.aliasMap,
            loading: false,
            creating: true,
            error: null,
          });
        } else {
          set((state) => {
            const next = mergeCreatedSessionState(state, merged, sessionId, directAttachName);
            nextAttachName = next.attachName;
            return {
              sessions: next.sessions,
              aliasMap: next.aliasMap,
              error: null,
            };
          });
        }
        let linkError: unknown = null;
        if (existing.projectSlug && existing.taskId) {
          try {
            await useBoard.getState().linkSession(api, existing.projectSlug, existing.taskId, {
              linkedSessionId: sessionId,
            });
          } catch (err: unknown) {
            console.error("[sessions] Failed to relink restarted session:", err);
            linkError = err;
          }
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        }
        if (linkError) {
          if (nextAttachName) {
            try {
              await deleteAttachableSession(api, nextAttachName);
              await get().load(api);
            } catch (cleanupErr: unknown) {
              console.error("[sessions] Failed to clean up unlinked restarted session:", cleanupErr);
            }
          } else {
            try {
              await deleteWorkspaceSession(api, sessionId);
              await get().load(api);
            } catch (cleanupErr: unknown) {
              console.error("[sessions] Failed to delete unlinked restarted session:", cleanupErr);
            }
          }
          set({ creating: false, error: linkError instanceof AppError ? linkError.category : "server" });
          return null;
        }
        set({ creating: false, error: null });
        return { sessionId, attachName: nextAttachName };
      }
      const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", { name: attachName });
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      const restarted = typeof response.name === "string" && response.name.trim() ? response.name.trim() : attachName;
      await get().load(api);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      set({ creating: false, error: null });
      return { sessionId: restarted, attachName: restarted };
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
      console.error("[sessions] Failed to restart session:", err);
      set({ creating: false, error: err instanceof AppError ? err.category : "server" });
      return null;
    }
  },

  resolveAttachName: (linkedSessionId) => {
    if (!linkedSessionId) return null;
    return get().aliasMap[linkedSessionId] ?? null;
  },
}));
