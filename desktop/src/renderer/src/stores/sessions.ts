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

interface SessionsState {
  sessions: AttachableSession[];
  aliasMap: Record<string, string>;
  loading: boolean;
  error: AppErrorCategory | null;
  load(api: ApiClient): Promise<void>;
  resolveAttachName(linkedSessionId: string | null): string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: [],
  aliasMap: {},
  loading: false,
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

  resolveAttachName: (linkedSessionId) => {
    if (!linkedSessionId) return null;
    return get().aliasMap[linkedSessionId] ?? null;
  },
}));
