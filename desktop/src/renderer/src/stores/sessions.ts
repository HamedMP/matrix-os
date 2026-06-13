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
  load(api: ApiClient): Promise<void>;
  create(api: ApiClient, input: SessionCreateInput): Promise<CreatedSession | null>;
  resolveAttachName(linkedSessionId: string | null): string | null;
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
    set({ creating: true });
    try {
      const res = await api.post<{ session?: { id?: unknown } }>("/api/sessions", input);
      const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
      // Reload so the merged aliasMap resolves the new session's zellij name
      // (the attach target). load() clears `loading`; restore `creating`.
      await get().load(api);
      set({ creating: false, error: null });
      if (!sessionId) return null;
      return { sessionId, attachName: get().aliasMap[sessionId] ?? null };
    } catch (err: unknown) {
      console.error("[sessions] Failed to create session:", err);
      set({ creating: false, error: err instanceof AppError ? err.category : "server" });
      return null;
    }
  },

  resolveAttachName: (linkedSessionId) => {
    if (!linkedSessionId) return null;
    return get().aliasMap[linkedSessionId] ?? null;
  },
}));
