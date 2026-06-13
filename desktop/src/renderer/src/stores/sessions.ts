// Attachable session list: zellij sessions (GET /api/terminal/sessions ->
// { sessions: [{ name, status, ... }] }) merged with workspace records
// (GET /api/sessions -> { sessions: [{ id, runtime: { zellijSession? } }], nextCursor }).
// Only entries with a real zellij attach name exist here (L6).
import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import {
  mergeAttachableSessions,
  type AttachableSession,
  type WorkspaceSessionDTO,
  type ZellijSessionDTO,
} from "../lib/session-merge";

export interface SessionCreateInput {
  kind: "shell" | "agent";
  agent?: "claude" | "codex" | "opencode" | "pi";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  prompt?: string;
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
  create(api: ApiClient, input: SessionCreateInput): Promise<CreatedSession | null>;
  kill(api: ApiClient, attachName: string): Promise<boolean>;
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

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: [],
  aliasMap: {},
  loading: false,
  creating: false,
  error: null,
  createError: null,

  load: async (api) => {
    set({ loading: true });
    try {
      const [zellijResponse, workspaceResponse] = await Promise.all([
        api.get<{ sessions: unknown }>("/api/terminal/sessions"),
        api.get<{ sessions: unknown; nextCursor: string | null }>("/api/sessions"),
      ]);
      const merged = mergeAttachableSessions(
        asArray<ZellijSessionDTO>(zellijResponse.sessions),
        asArray<WorkspaceSessionDTO>(workspaceResponse.sessions),
      );
      set({
        sessions: merged.sessions,
        aliasMap: merged.aliasMap,
        loading: false,
        error: null,
      });
    } catch (err: unknown) {
      console.error("[sessions] Failed to load sessions:", err);
      set({
        loading: false,
        error: err instanceof AppError ? err.category : "server",
      });
    }
  },

  create: async (api, input) => {
    set({ creating: true, createError: null });
    try {
      const res = await api.post<{ session?: { id?: unknown } }>("/api/sessions", input);
      const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
      // Reload so the merged aliasMap resolves the new session's zellij name
      // (the attach target). load() clears `loading`; restore `creating`.
      await get().load(api);
      set({ creating: false, error: null, createError: null });
      if (!sessionId) return null;
      return { sessionId, attachName: get().aliasMap[sessionId] ?? null };
    } catch (err: unknown) {
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
    try {
      await api.delete(`/api/terminal/sessions/${encodeURIComponent(attachName)}?force=1`);
      await get().load(api);
      return true;
    } catch (err: unknown) {
      console.error("[sessions] Failed to kill session:", err);
      set({ error: err instanceof AppError ? err.category : "server" });
      return false;
    }
  },

  resolveAttachName: (linkedSessionId) => {
    if (!linkedSessionId) return null;
    return get().aliasMap[linkedSessionId] ?? null;
  },
}));
