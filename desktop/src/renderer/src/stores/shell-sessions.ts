import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import { twoWordShellSessionName } from "../lib/shell-session-names";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

export type ShellSessionPlacement = "active" | "background";
export type ShellVisualStatus = "running" | "waiting" | "finished" | "idle";

export interface ShellSessionSummary {
  name: string;
  workspaceId: string;
  tabId: string;
  revision: number;
  workspaceRevision: number;
  projectId?: string;
  cwd: string;
  status?: "active" | "exited" | "degraded";
  placement?: ShellSessionPlacement;
  createdAt?: string;
  updatedAt?: string;
  attachedClients?: number;
  latestSeq?: number | null;
  lastSeenSeq?: number | null;
  unread?: boolean;
  visualStatus?: ShellVisualStatus;
  agent?: "claude" | "codex" | "opencode" | "pi";
  subtitle?: string;
  lastAction?: string;
  agentUpdatedAt?: string;
  model?: string;
  strength?: string;
  project?: string;
  repository?: string;
  branch?: string;
  pullRequest?: { number: number; url?: string };
  attachCommand?: string;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
}

export type ShellUiStatePatch = Partial<Pick<ShellSessionSummary, "placement" | "lastSeenSeq">>;
export interface ShellSessionCreateOptions {
  cmd?: string;
  agent?: NonNullable<ShellSessionSummary["agent"]>;
}

interface ShellSessionsState {
  sessions: ShellSessionSummary[];
  loading: boolean;
  creating: boolean;
  error: AppErrorCategory | null;
  loadSequence: number;
  authoritativeRevision: number;
  load(api: ApiClient): Promise<ShellSessionSummary[] | null>;
  create(api: ApiClient, options?: ShellSessionCreateOptions): Promise<ShellSessionSummary | null>;
  adoptCreatedSession(name: string): void;
  deleteSession(api: ApiClient, name: string): Promise<boolean>;
  rename(api: ApiClient, name: string, nextName: string): Promise<boolean>;
  reorder(api: ApiClient, fromName: string, toName: string): Promise<boolean>;
  patchUiState(api: ApiClient, name: string, patch: ShellUiStatePatch): Promise<boolean>;
}

const DEFAULT_CWD = "projects";
const TERMINAL_REF_KEY_PATTERN = /^tws_[0-9a-f]{32}:tt_[0-9a-f]{32}$/;

export function isValidShellSessionName(name: string): boolean {
  return TERMINAL_REF_KEY_PATTERN.test(name);
}

export function isValidShellDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 120 && !/[\u0000-\u001f\u007f]/.test(trimmed);
}

function shellConnectCommand(shell: Pick<ShellSessionSummary, "projectId" | "tabId">): string {
  return `matrix shell connect --project ${shell.projectId ?? "main"} --tab ${shell.tabId}`;
}

function nextShellName(): string {
  return twoWordShellSessionName();
}

function errorCategory(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asShellSession(value: unknown, workspace: { id: string; revision: number; projectId?: string }): ShellSessionSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^tt_[0-9a-f]{32}$/.test(record.id) || typeof record.name !== "string") return null;
  const shell: ShellSessionSummary = {
    name: `${workspace.id}:${record.id}`,
    workspaceId: workspace.id,
    tabId: record.id,
    revision: typeof record.revision === "number" ? record.revision : 0,
    workspaceRevision: workspace.revision,
    ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    subtitle: record.name,
  };
  if (record.status === "active" || record.status === "exited" || record.status === "degraded") shell.status = record.status;
  if (record.placement === "active" || record.placement === "background") shell.placement = record.placement;
  if (typeof record.createdAt === "string") shell.createdAt = record.createdAt;
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
  shell.attachCommand = shellConnectCommand(shell);
  if (record.agent === "claude" || record.agent === "codex" || record.agent === "opencode" || record.agent === "pi") {
    shell.agent = record.agent;
  }
  if (typeof record.subtitle === "string") shell.subtitle = record.subtitle;
  if (typeof record.lastAction === "string") shell.lastAction = record.lastAction;
  if (typeof record.agentUpdatedAt === "string") shell.agentUpdatedAt = record.agentUpdatedAt;
  if (typeof record.model === "string") shell.model = record.model;
  if (typeof record.strength === "string") shell.strength = record.strength;
  if (typeof record.project === "string") shell.project = record.project;
  if (typeof record.repository === "string") shell.repository = record.repository;
  if (typeof record.branch === "string") shell.branch = record.branch;
  if (record.pullRequest && typeof record.pullRequest === "object") {
    const pullRequest = record.pullRequest as Record<string, unknown>;
    if (Number.isSafeInteger(pullRequest.number) && (pullRequest.number as number) > 0) {
      shell.pullRequest = {
        number: pullRequest.number as number,
        ...(typeof pullRequest.url === "string" ? { url: pullRequest.url } : {}),
      };
    }
  }
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
  return asArray<Record<string, unknown>>(value).flatMap((entry) => {
    if (typeof entry.id !== "string" || !/^tws_[0-9a-f]{32}$/.test(entry.id) || !Array.isArray(entry.tabs)) return [];
    const workspace = {
      id: entry.id,
      revision: typeof entry.revision === "number" ? entry.revision : 0,
      ...(typeof entry.projectId === "string" ? { projectId: entry.projectId } : {}),
    };
    return entry.tabs.flatMap((tab) => {
      const shell = asShellSession(tab, workspace);
      return shell ? [shell] : [];
    });
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
    subtitle: nextName,
  };
}

function originalDisplayName(sessions: ShellSessionSummary[], name: string): string | undefined {
  return sessions.find((session) => session.name === name)?.subtitle;
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

function insertSessionAt(sessions: ShellSessionSummary[], session: ShellSessionSummary, index: number): ShellSessionSummary[] {
  if (sessions.some((entry) => entry.name === session.name)) return sessions;
  const next = [...sessions];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, session);
  return next;
}

function rollbackRename(
  sessions: ShellSessionSummary[],
  original: ShellSessionSummary,
  originalIndex: number,
  optimisticName: string,
): ShellSessionSummary[] {
  if (sessions.some((session) => session.name === original.name)) return sessions;
  const optimisticIndex = sessions.findIndex((session) => session.name === optimisticName);
  if (optimisticIndex < 0) return insertSessionAt(sessions, original, originalIndex);
  return sessions.map((session, index) => (index === optimisticIndex ? original : session));
}

function rollbackOrder(current: ShellSessionSummary[], previousOrder: ShellSessionSummary[]): ShellSessionSummary[] {
  const restored = previousOrder.flatMap((session) => {
    const currentSession = current.find((entry) => entry.name === session.name);
    return currentSession ? [currentSession] : [];
  });
  const additions = current.filter((session) => !previousOrder.some((entry) => entry.name === session.name));
  return [...restored, ...additions];
}

function rollbackUiPatch(
  current: ShellSessionSummary[],
  name: string,
  previous: ShellSessionSummary,
  optimisticPatch: ShellUiStatePatch,
): ShellSessionSummary[] {
  return current.map((session) => {
    if (session.name !== name) return session;
    let restored: ShellSessionSummary = session;
    for (const key of Object.keys(optimisticPatch) as Array<keyof ShellUiStatePatch>) {
      if (Object.is(session[key], optimisticPatch[key])) {
        restored = { ...restored, [key]: previous[key] };
      }
    }
    return deriveUnread(restored);
  });
}

async function fetchShellSessions(api: ApiClient): Promise<ShellSessionSummary[]> {
  const response = await api.get<{ workspaces: unknown }>("/api/terminal/workspaces");
  return parseShellSessions(response.workspaces);
}

export const useShellSessions = create<ShellSessionsState>()((set, get) => ({
  sessions: [],
  loading: false,
  creating: false,
  error: null,
  loadSequence: 0,
  authoritativeRevision: 0,

  load: async (api) => {
    const generation = captureRuntimeGeneration();
    const sequence = get().loadSequence + 1;
    set({ loading: true, error: null, loadSequence: sequence });
    try {
      const sessions = await fetchShellSessions(api);
      if (!isCurrentRuntimeGeneration(generation) || sequence !== get().loadSequence) return null;
      set((state) => ({
        sessions,
        loading: false,
        error: null,
        authoritativeRevision: state.authoritativeRevision + 1,
      }));
      return sessions;
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || sequence !== get().loadSequence) return null;
      console.error("[shell-sessions] Failed to load shell sessions:", err);
      set({ loading: false, error: errorCategory(err) });
      return null;
    }
  },

  create: async (api, options = {}) => {
    if (get().creating) return null;
    // A computer switch advances the runtime generation and clears this store;
    // a create that settles afterwards belongs to the previous computer and
    // must not repopulate the new one (the transition already reset `creating`).
    const generation = captureRuntimeGeneration();
    set({ creating: true, error: null });
    const displayName = nextShellName();
    try {
      const ensured = await api.post<{ workspace?: Record<string, unknown> }>("/api/terminal/workspaces/ensure", {});
      const workspaceId = typeof ensured.workspace?.id === "string" ? ensured.workspace.id : "";
      if (!/^tws_[0-9a-f]{32}$/.test(workspaceId)) throw new Error("Invalid terminal workspace response");
      const response = await api.post<{ tab?: unknown }>(`/api/terminal/workspaces/${workspaceId}/tabs`, {
        name: displayName,
        cwd: DEFAULT_CWD,
        ...(options.cmd ? { command: options.cmd } : {}),
        ...(options.agent ? { agent: { providerId: options.agent } } : {}),
      });
      if (!isCurrentRuntimeGeneration(generation)) return null;
      const created = asShellSession(response.tab, {
        id: workspaceId,
        revision: typeof ensured.workspace?.revision === "number" ? ensured.workspace.revision : 0,
      });
      if (!created) throw new Error("Invalid terminal tab response");
      const refreshSequence = get().loadSequence + 1;
      set({ loadSequence: refreshSequence });
      try {
        const sessions = await fetchShellSessions(api);
        if (!isCurrentRuntimeGeneration(generation)) return null;
        if (refreshSequence !== get().loadSequence) {
          set({ creating: false, error: null });
          return created;
        }
        const refreshed = sessions.find((session) => session.name === created.name) ?? created;
        set((state) => ({
          sessions: sessions.some((session) => session.name === created.name) ? sessions : [refreshed, ...state.sessions],
          creating: false,
          loading: false,
          error: null,
          authoritativeRevision: state.authoritativeRevision + 1,
        }));
      } catch (refreshErr: unknown) {
        if (!isCurrentRuntimeGeneration(generation)) return null;
        if (refreshSequence !== get().loadSequence) {
          set({ creating: false, error: null });
          return created;
        }
        console.error("[shell-sessions] Failed to refresh after shell create:", refreshErr);
        set((state) => ({
          sessions: state.sessions.some((session) => session.name === created.name) ? state.sessions : [created, ...state.sessions],
          creating: false,
          loading: false,
          error: errorCategory(refreshErr),
        }));
      }
      return created;
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(generation)) return null;
      console.error("[shell-sessions] Failed to create shell session:", err);
      set({ creating: false, error: errorCategory(err) });
      return null;
    }
  },

  adoptCreatedSession: (name) => {
    if (!isValidShellSessionName(name)) return;
    const [workspaceId, tabId] = name.split(":") as [string, string];
    set((state) => (
      state.sessions.some((session) => session.name === name)
        ? state
        : {
            sessions: [{
              name,
              workspaceId,
              tabId,
              revision: 0,
              workspaceRevision: 0,
              cwd: "",
              status: "active",
              placement: "active",
              attachCommand: shellConnectCommand({ tabId }),
            }, ...state.sessions],
            // A session-list fetch that started before this confirmed create
            // can return a stale snapshot without the new session. Advance
            // the sequence so it cannot overwrite this optimistic entry.
            loadSequence: state.loadSequence + 1,
            authoritativeRevision: state.authoritativeRevision + 1,
          }
    ));
  },

  deleteSession: async (api, name) => {
    const generation = captureRuntimeGeneration();
    const previous = get().sessions;
    const deletedIndex = previous.findIndex((session) => session.name === name);
    const deleted = deletedIndex >= 0 ? previous[deletedIndex] : undefined;
    set({ sessions: previous.filter((session) => session.name !== name), error: null });
    try {
      if (!deleted) throw new Error("Terminal tab not found");
      await api.delete(`/api/terminal/workspaces/${deleted.workspaceId}/tabs/${deleted.tabId}`);
      return true;
    } catch (err: unknown) {
      // After a computer switch the cleared list must not get the old
      // computer's session restored into it.
      if (!isCurrentRuntimeGeneration(generation)) return false;
      console.error("[shell-sessions] Failed to delete shell session:", err);
      set((state) => ({
        sessions: deleted ? insertSessionAt(state.sessions, deleted, deletedIndex) : state.sessions,
        error: errorCategory(err),
      }));
      return false;
    }
  },

  rename: async (api, name, nextNameRaw) => {
    const nextName = nextNameRaw.trim();
    if (originalDisplayName(get().sessions, name) === nextName) return true;
    if (nextName.length < 1 || nextName.length > 120) {
      set({ error: "server" });
      return false;
    }
    const generation = captureRuntimeGeneration();
    const previous = get().sessions;
    const originalIndex = previous.findIndex((session) => session.name === name);
    const original = originalIndex >= 0 ? previous[originalIndex] : undefined;
    set({
      sessions: previous.map((session) => (session.name === name ? optimisticRename(session, nextName) : session)),
      error: null,
    });
    try {
      if (!original) throw new Error("Terminal tab not found");
      const response = await api.patch<{ tab?: unknown }>(`/api/terminal/workspaces/${original.workspaceId}/tabs/${original.tabId}`, {
        name: nextName,
        baseRevision: original.revision,
      });
      if (!isCurrentRuntimeGeneration(generation)) return false;
      const renamed = asShellSession(response.tab, {
        id: original.workspaceId,
        revision: original.workspaceRevision,
        ...(original.projectId ? { projectId: original.projectId } : {}),
      });
      if (renamed) {
        set((state) => ({
          sessions: state.sessions.map((session) => (session.name === name ? renamed : session)),
          error: null,
        }));
      }
      return true;
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(generation)) return false;
      console.error("[shell-sessions] Failed to rename shell session:", err);
      set((state) => ({
        sessions: original ? state.sessions.map((session) => session.name === name ? original : session) : state.sessions,
        error: errorCategory(err),
      }));
      return false;
    }
  },

  reorder: async (api, fromName, toName) => {
    const previous = get().sessions;
    const next = moveSession(previous, fromName, toName);
    if (!next) return true;
    const moved = previous.find((session) => session.name === fromName);
    const target = previous.find((session) => session.name === toName);
    if (!moved || !target || moved.workspaceId !== target.workspaceId) return false;
    // A runtime switch clears this store while the PUT is in flight; the old
    // computer's response must not repopulate the new computer's list.
    const runtimeGeneration = captureRuntimeGeneration();
    set({ sessions: next, error: null });
    try {
      const workspaceTabs = next.filter((session) => session.workspaceId === moved.workspaceId);
      await api.put<{ workspace?: unknown }>(`/api/terminal/workspaces/${moved.workspaceId}/tabs/order`, {
        tabIds: workspaceTabs.map((session) => session.tabId),
        baseRevision: moved.workspaceRevision,
      });
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return true;
      return true;
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
      console.error("[shell-sessions] Failed to reorder shell sessions:", err);
      set((state) => ({ sessions: rollbackOrder(state.sessions, previous), error: errorCategory(err) }));
      return false;
    }
  },

  patchUiState: async (api, name, patch) => {
    const previous = get().sessions;
    const previousSession = previous.find((session) => session.name === name);
    set({
      sessions: previous.map((session) => (session.name === name ? applyUiPatch(session, patch) : session)),
      error: null,
    });
    try {
      if (!previousSession) throw new Error("Terminal tab not found");
      const response = await api.patch<{ tab?: unknown }>(`/api/terminal/workspaces/${previousSession.workspaceId}/tabs/${previousSession.tabId}/ui-state`, {
        ...patch,
        baseRevision: previousSession.revision,
      });
      const updated = asShellSession(response.tab, {
        id: previousSession.workspaceId,
        revision: previousSession.workspaceRevision,
        ...(previousSession.projectId ? { projectId: previousSession.projectId } : {}),
      });
      if (updated) {
        set((state) => ({
          sessions: state.sessions.map((session) => (session.name === updated.name ? updated : session)),
          error: null,
        }));
      }
      return true;
    } catch (err: unknown) {
      console.error("[shell-sessions] Failed to update shell session UI state:", err);
      set((state) => ({
        sessions: previousSession ? rollbackUiPatch(state.sessions, name, previousSession, patch) : state.sessions,
        error: errorCategory(err),
      }));
      return false;
    }
  },
}));
