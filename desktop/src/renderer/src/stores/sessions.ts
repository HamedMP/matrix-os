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
  create(api: ApiClient): Promise<AttachableSession | null>;
  resolveAttachName(linkedSessionId: string | null): string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

let loadSequence = 0;

function nextSessionName(): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `operator-${Date.now().toString(36)}-${suffix}`;
}

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: [],
  aliasMap: {},
  loading: false,
  error: null,

  load: async (api) => {
    const sequence = ++loadSequence;
    set({ loading: true, error: null });
    try {
      const [zellijResponse, workspaceResponse] = await Promise.all([
        api.get<{ sessions: unknown }>("/api/terminal/sessions"),
        api.get<{ sessions: unknown; nextCursor: string | null }>("/api/sessions"),
      ]);
      const merged = mergeAttachableSessions(
        asArray<ZellijSessionDTO>(zellijResponse.sessions),
        asArray<WorkspaceSessionDTO>(workspaceResponse.sessions),
      );
      if (sequence !== loadSequence) return;
      set({
        sessions: merged.sessions,
        aliasMap: merged.aliasMap,
        loading: false,
        error: null,
      });
    } catch (err: unknown) {
      if (sequence !== loadSequence) return;
      console.error("[sessions] Failed to load sessions:", err);
      set({
        loading: false,
        error: err instanceof AppError ? err.category : "server",
      });
    }
  },

  create: async (api) => {
    const name = nextSessionName();
    set({ loading: true });
    try {
      const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", { name });
      const attachName = typeof response.name === "string" && response.name.trim() ? response.name.trim() : name;
      const refreshSequence = loadSequence + 1;
      await get().load(api);
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
          ? { ...loadingPatch, error: refreshError }
          : { sessions: [created, ...state.sessions], ...loadingPatch, error: refreshError };
      });
      return created;
    } catch (err: unknown) {
      console.error("[sessions] Failed to create session:", err);
      set({
        loading: false,
        error: err instanceof AppError ? err.category : "server",
      });
      return null;
    }
  },

  resolveAttachName: (linkedSessionId) => {
    if (!linkedSessionId) return null;
    return get().aliasMap[linkedSessionId] ?? null;
  },
}));
