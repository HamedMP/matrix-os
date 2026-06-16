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
import { useBoard } from "./board";

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
  load(api: ApiClient): Promise<void>;
  create(api: ApiClient, input?: SessionCreateInput): Promise<CreatedSession | null>;
  kill(api: ApiClient, attachName: string): Promise<boolean>;
  restart(api: ApiClient, attachName: string): Promise<CreatedSession | null>;
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
  creating: false,
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

  create: async (api, input) => {
    set({ creating: true, error: null });
    try {
      if (!input) {
        const name = nextSessionName();
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
            ? { ...loadingPatch, creating: false, error: refreshError }
            : { sessions: [created, ...state.sessions], ...loadingPatch, creating: false, error: refreshError };
        });
        return { sessionId: attachName, attachName };
      }

      const res = await api.post<{
        session?: { id?: unknown; runtime?: { zellijSession?: unknown } | null };
      }>("/api/sessions", input);
      const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
      const directAttachName =
        typeof res.session?.runtime?.zellijSession === "string"
          ? res.session.runtime.zellijSession
          : null;
      // Reload so the merged aliasMap resolves the new session's zellij name
      // (the attach target). load() clears `loading`; restore `creating`.
      await get().load(api);
      const refreshError = get().error;
      if (!sessionId) {
        set({ creating: false, error: refreshError });
        return null;
      }
      if (refreshError) {
        await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`).catch((err: unknown) => {
          console.warn(
            "[sessions] Failed to clean up created session after refresh failure:",
            err instanceof Error ? err.message : String(err),
          );
        });
        set({ creating: false, error: refreshError });
        return null;
      }
      set({ creating: false, error: null });
      return { sessionId, attachName: get().aliasMap[sessionId] ?? directAttachName };
    } catch (err: unknown) {
      console.error("[sessions] Failed to create session:", err);
      set({ creating: false, error: err instanceof AppError ? err.category : "server" });
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

  restart: async (api, attachName) => {
    set({ creating: true });
    try {
      const existing = get().sessions.find((session) => session.attachName === attachName) ?? null;
      try {
        await api.delete(`/api/terminal/sessions/${encodeURIComponent(attachName)}?force=1`);
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.category === "notFound")) throw err;
      }
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
        const sessionId = typeof res.session?.id === "string" ? res.session.id : null;
        const directAttachName =
          typeof res.session?.runtime?.zellijSession === "string"
            ? res.session.runtime.zellijSession
            : null;
        await get().load(api);
        const refreshError = get().error;
        if (!sessionId) {
          set({ creating: false, error: refreshError });
          return null;
        }
        if (refreshError) {
          await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`).catch((err: unknown) => {
            console.warn(
              "[sessions] Failed to clean up restarted session after refresh failure:",
              err instanceof Error ? err.message : String(err),
            );
          });
          set({ creating: false, error: refreshError });
          return null;
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
        }
        set({ creating: false, error: linkError instanceof AppError ? linkError.category : linkError ? "server" : null });
        return { sessionId, attachName: get().aliasMap[sessionId] ?? directAttachName };
      }
      const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", { name: attachName });
      const restarted = typeof response.name === "string" && response.name.trim() ? response.name.trim() : attachName;
      await get().load(api);
      set({ creating: false, error: null });
      return { sessionId: restarted, attachName: restarted };
    } catch (err: unknown) {
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
