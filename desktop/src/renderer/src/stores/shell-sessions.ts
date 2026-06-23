import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";

export type ShellSessionPlacement = "active" | "background";
export type ShellVisualStatus = "running" | "waiting" | "finished" | "idle";

export interface ShellSessionSummary {
  name: string;
  status?: "active" | "exited" | "degraded";
  placement?: ShellSessionPlacement;
  updatedAt?: string;
  attachedClients?: number;
  latestSeq?: number | null;
  lastSeenSeq?: number | null;
  unread?: boolean;
  visualStatus?: ShellVisualStatus;
  attachCommand?: string;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
}

export type ShellUiStatePatch = Partial<Pick<ShellSessionSummary, "placement" | "lastSeenSeq" | "visualStatus">>;

interface ShellSessionsState {
  sessions: ShellSessionSummary[];
  loading: boolean;
  creating: boolean;
  error: AppErrorCategory | null;
  loadSequence: number;
  load(api: ApiClient): Promise<void>;
  create(api: ApiClient): Promise<ShellSessionSummary | null>;
  deleteSession(api: ApiClient, name: string): Promise<boolean>;
  rename(api: ApiClient, name: string, nextName: string): Promise<boolean>;
  reorder(api: ApiClient, fromName: string, toName: string): Promise<boolean>;
  patchUiState(api: ApiClient, name: string, patch: ShellUiStatePatch): Promise<boolean>;
}

const SHELL_SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;
const DEFAULT_CWD = "projects";
const CREATE_ATTEMPTS = 3;

export function isValidShellSessionName(name: string): boolean {
  return SHELL_SESSION_NAME_PATTERN.test(name);
}

function shellConnectCommand(name: string): string {
  return `matrix shell connect ${name}`;
}

function randomShellSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 7);
  }
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7);
}

function nextShellName(): string {
  return `matrix-${randomShellSuffix()}`;
}

function isSessionExistsError(err: unknown): boolean {
  return err instanceof AppError && err.detail === "session_exists";
}

function errorCategory(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asShellSession(value: unknown): ShellSessionSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !isValidShellSessionName(record.name)) return null;
  const shell: ShellSessionSummary = { name: record.name };
  if (record.status === "active" || record.status === "exited" || record.status === "degraded") shell.status = record.status;
  if (record.placement === "active" || record.placement === "background") shell.placement = record.placement;
  if (typeof record.updatedAt === "string") shell.updatedAt = record.updatedAt;
  if (typeof record.attachedClients === "number" && Number.isFinite(record.attachedClients)) shell.attachedClients = record.attachedClients;
  if (typeof record.latestSeq === "number" && Number.isFinite(record.latestSeq)) shell.latestSeq = record.latestSeq;
  else if (record.latestSeq === null) shell.latestSeq = null;
  if (typeof record.lastSeenSeq === "number" && Number.isFinite(record.lastSeenSeq)) shell.lastSeenSeq = record.lastSeenSeq;
  else if (record.lastSeenSeq === null) shell.lastSeenSeq = null;
  if (typeof record.unread === "boolean") shell.unread = record.unread;
  if (
    record.visualStatus === "running" ||
    record.visualStatus === "waiting" ||
    record.visualStatus === "finished" ||
    record.visualStatus === "idle"
  ) {
    shell.visualStatus = record.visualStatus;
  }
  if (typeof record.attachCommand === "string") shell.attachCommand = record.attachCommand;
  if (Array.isArray(record.tabs)) {
    const tabs: NonNullable<ShellSessionSummary["tabs"]> = [];
    for (const tab of record.tabs) {
      if (!tab || typeof tab !== "object") continue;
      const tabRecord = tab as Record<string, unknown>;
      if (!Number.isInteger(tabRecord.idx)) continue;
      tabs.push({
        idx: tabRecord.idx as number,
        ...(typeof tabRecord.name === "string" ? { name: tabRecord.name } : {}),
        ...(typeof tabRecord.focused === "boolean" ? { focused: tabRecord.focused } : {}),
      });
    }
    if (tabs.length > 0) shell.tabs = tabs;
  }
  return deriveUnread(shell);
}

function parseShellSessions(value: unknown): ShellSessionSummary[] {
  return asArray<unknown>(value).flatMap((entry) => {
    const shell = asShellSession(entry);
    return shell ? [shell] : [];
  });
}

function deriveUnread(shell: ShellSessionSummary): ShellSessionSummary {
  if (shell.latestSeq === undefined || shell.latestSeq === null || shell.lastSeenSeq === undefined || shell.lastSeenSeq === null) {
    return shell;
  }
  return { ...shell, unread: shell.latestSeq > shell.lastSeenSeq };
}

function optimisticRename(shell: ShellSessionSummary, nextName: string): ShellSessionSummary {
  return {
    ...shell,
    name: nextName,
    attachCommand: shell.attachCommand ? shellConnectCommand(nextName) : shell.attachCommand,
  };
}

function applyUiPatch(shell: ShellSessionSummary, patch: ShellUiStatePatch): ShellSessionSummary {
  return deriveUnread({ ...shell, ...patch });
}

function moveSession(sessions: ShellSessionSummary[], fromName: string, toName: string): ShellSessionSummary[] | null {
  const fromIndex = sessions.findIndex((session) => session.name === fromName);
  const toIndex = sessions.findIndex((session) => session.name === toName);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  const next = [...sessions];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return null;
  next.splice(toIndex, 0, moved);
  return next;
}

async function fetchShellSessions(api: ApiClient): Promise<ShellSessionSummary[]> {
  const response = await api.get<{ sessions: unknown }>("/api/terminal/sessions");
  return parseShellSessions(response.sessions);
}

export const useShellSessions = create<ShellSessionsState>()((set, get) => ({
  sessions: [],
  loading: false,
  creating: false,
  error: null,
  loadSequence: 0,

  load: async (api) => {
    const sequence = get().loadSequence + 1;
    set({ loading: true, error: null, loadSequence: sequence });
    try {
      const sessions = await fetchShellSessions(api);
      if (sequence !== get().loadSequence) return;
      set({ sessions, loading: false, error: null });
    } catch (err: unknown) {
      if (sequence !== get().loadSequence) return;
      console.error("[shell-sessions] Failed to load shell sessions:", err);
      set({ loading: false, error: errorCategory(err) });
    }
  },

  create: async (api) => {
    if (get().creating) return null;
    set({ creating: true, error: null });
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const name = nextShellName();
      try {
        const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", { name, cwd: DEFAULT_CWD });
        const createdName = typeof response.name === "string" && isValidShellSessionName(response.name) ? response.name : name;
        let created: ShellSessionSummary = {
          name: createdName,
          status: "active",
          placement: "active",
          attachCommand: shellConnectCommand(createdName),
        };
        try {
          const sessions = await fetchShellSessions(api);
          created = sessions.find((session) => session.name === createdName) ?? created;
          set((state) => ({
            sessions: sessions.some((session) => session.name === createdName) ? sessions : [created, ...state.sessions],
            creating: false,
            error: null,
          }));
        } catch (refreshErr: unknown) {
          console.error("[shell-sessions] Failed to refresh after shell create:", refreshErr);
          set((state) => ({
            sessions: state.sessions.some((session) => session.name === created.name) ? state.sessions : [created, ...state.sessions],
            creating: false,
            error: errorCategory(refreshErr),
          }));
        }
        return created;
      } catch (err: unknown) {
        if (isSessionExistsError(err) && attempt < CREATE_ATTEMPTS - 1) continue;
        console.error("[shell-sessions] Failed to create shell session:", err);
        set({ creating: false, error: errorCategory(err) });
        return null;
      }
    }
    set({ creating: false, error: "server" });
    return null;
  },

  deleteSession: async (api, name) => {
    const previous = get().sessions;
    const deleted = previous.find((session) => session.name === name);
    set({ sessions: previous.filter((session) => session.name !== name), error: null });
    try {
      await api.delete(`/api/terminal/sessions/${encodeURIComponent(name)}?force=1`);
      return true;
    } catch (err: unknown) {
      console.error("[shell-sessions] Failed to delete shell session:", err);
      set((state) => ({
        sessions: deleted && !state.sessions.some((session) => session.name === name) ? previous : state.sessions,
        error: errorCategory(err),
      }));
      return false;
    }
  },

  rename: async (api, name, nextNameRaw) => {
    const nextName = nextNameRaw.trim();
    if (name === nextName) return true;
    if (!isValidShellSessionName(nextName)) {
      set({ error: "server" });
      return false;
    }
    const previous = get().sessions;
    set({
      sessions: previous.map((session) => (session.name === name ? optimisticRename(session, nextName) : session)),
      error: null,
    });
    try {
      const response = await api.put<{ session?: unknown }>(`/api/terminal/sessions/${encodeURIComponent(name)}/rename`, { name: nextName });
      const renamed = asShellSession(response.session) ?? null;
      if (renamed) {
        set((state) => ({
          sessions: state.sessions.map((session) => (session.name === nextName ? renamed : session)),
          error: null,
        }));
      }
      return true;
    } catch (err: unknown) {
      console.error("[shell-sessions] Failed to rename shell session:", err);
      set({ sessions: previous, error: errorCategory(err) });
      return false;
    }
  },

  reorder: async (api, fromName, toName) => {
    const previous = get().sessions;
    const next = moveSession(previous, fromName, toName);
    if (!next) return true;
    set({ sessions: next, error: null });
    try {
      const response = await api.put<{ sessions?: unknown }>("/api/terminal/sessions/order", {
        order: next.map((session) => session.name),
      });
      if (Array.isArray(response.sessions)) {
        set({ sessions: parseShellSessions(response.sessions), error: null });
      }
      return true;
    } catch (err: unknown) {
      console.error("[shell-sessions] Failed to reorder shell sessions:", err);
      set({ sessions: previous, error: errorCategory(err) });
      return false;
    }
  },

  patchUiState: async (api, name, patch) => {
    const previous = get().sessions;
    set({
      sessions: previous.map((session) => (session.name === name ? applyUiPatch(session, patch) : session)),
      error: null,
    });
    try {
      const response = await api.patch<{ session?: unknown }>(`/api/terminal/sessions/${encodeURIComponent(name)}/ui-state`, patch);
      const updated = asShellSession(response.session) ?? null;
      if (updated) {
        set((state) => ({
          sessions: state.sessions.map((session) => (session.name === updated.name ? updated : session)),
          error: null,
        }));
      }
      return true;
    } catch (err: unknown) {
      console.error("[shell-sessions] Failed to update shell session UI state:", err);
      set({ sessions: previous, error: errorCategory(err) });
      return false;
    }
  },
}));
