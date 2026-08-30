import { create } from "zustand";
import type { ApiClient } from "../lib/api";
import {
  DEFAULT_TERMINAL_THEME_ID,
  type TerminalThemeId,
} from "../lib/terminal/terminal-settings-types";
import { TERMINAL_THEME_OPTIONS } from "../lib/terminal/terminal-themes";
import {
  captureRuntimeGeneration,
  isCurrentRuntimeGeneration,
} from "./runtime-generation";

interface TerminalAppearanceState {
  themeId: TerminalThemeId;
  confirmedThemeId: TerminalThemeId;
  hydrated: boolean;
  selectionRevision: number;
  loadRevision: number;
  load: (api: TerminalPreferencesApi | null) => Promise<void>;
  setThemeId: (themeId: TerminalThemeId, api: TerminalPreferencesApi | null) => void;
}

type TerminalPreferencesApi = Pick<ApiClient, "get" | "put">;

interface TerminalPreferencesResponse {
  preferences?: { shellThemeId?: unknown };
}

interface PersistCallbacks {
  getConfirmedThemeId: () => TerminalThemeId;
  onPersisted: (themeId: TerminalThemeId) => void;
  onReconciled: (themeId: TerminalThemeId, selectionRevision: number) => void;
}

let persistQueueGeneration = captureRuntimeGeneration();
let persistQueue: Promise<void> = Promise.resolve();

function isSelectableTerminalThemeId(value: unknown): value is TerminalThemeId {
  return typeof value === "string" && TERMINAL_THEME_OPTIONS.some((option) => option.id === value);
}

function resolveTerminalThemeId(result: TerminalPreferencesResponse): TerminalThemeId {
  return isSelectableTerminalThemeId(result.preferences?.shellThemeId)
    ? result.preferences.shellThemeId
    : DEFAULT_TERMINAL_THEME_ID;
}

function warn(operation: "load" | "persist" | "reconcile", error: unknown): void {
  console.warn(
    `[terminal-appearance] ${operation} failed:`,
    error instanceof Error ? error.message : String(error),
  );
}

function queueForRuntime(runtimeGeneration: number): Promise<void> {
  return persistQueueGeneration === runtimeGeneration ? persistQueue : Promise.resolve();
}

function persist(
  api: TerminalPreferencesApi | null,
  themeId: TerminalThemeId,
  selectionRevision: number,
  callbacks: PersistCallbacks,
): void {
  if (!api) return;
  const runtimeGeneration = captureRuntimeGeneration();
  const previousQueue = queueForRuntime(runtimeGeneration);
  persistQueueGeneration = runtimeGeneration;
  persistQueue = previousQueue.then(async () => {
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
    try {
      await api.put("/api/terminal/preferences", { shellThemeId: themeId });
      if (isCurrentRuntimeGeneration(runtimeGeneration)) {
        callbacks.onPersisted(themeId);
      }
    } catch (error: unknown) {
      warn("persist", error);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;

      let authoritativeThemeId = callbacks.getConfirmedThemeId();
      try {
        const result = await api.get<TerminalPreferencesResponse>("/api/terminal/preferences");
        authoritativeThemeId = resolveTerminalThemeId(result);
      } catch (reconcileError: unknown) {
        warn("reconcile", reconcileError);
      }
      if (isCurrentRuntimeGeneration(runtimeGeneration)) {
        callbacks.onReconciled(authoritativeThemeId, selectionRevision);
      }
    }
  }).catch((error: unknown) => {
    warn("persist", error);
  });
}

export const useTerminalAppearance = create<TerminalAppearanceState>()((set, get) => ({
  themeId: DEFAULT_TERMINAL_THEME_ID,
  confirmedThemeId: DEFAULT_TERMINAL_THEME_ID,
  hydrated: false,
  selectionRevision: 0,
  loadRevision: 0,

  load: async (api) => {
    const loadRevision = get().loadRevision + 1;
    const selectionRevision = get().selectionRevision;
    const runtimeGeneration = captureRuntimeGeneration();
    set({ loadRevision });
    if (!api) {
      set({ hydrated: true });
      return;
    }
    try {
      await queueForRuntime(runtimeGeneration);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      const result = await api.get<TerminalPreferencesResponse>("/api/terminal/preferences");
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      const themeId = resolveTerminalThemeId(result);
      set((state) => ({
        themeId: state.loadRevision === loadRevision && state.selectionRevision === selectionRevision
          ? themeId
          : state.themeId,
        confirmedThemeId: state.loadRevision === loadRevision
          && state.selectionRevision === selectionRevision
          ? themeId
          : state.confirmedThemeId,
        hydrated: true,
      }));
    } catch (error: unknown) {
      warn("load", error);
      if (isCurrentRuntimeGeneration(runtimeGeneration)) {
        set((state) => state.loadRevision === loadRevision ? { hydrated: true } : {});
      }
    }
  },

  setThemeId: (themeId, api) => {
    if (!api) return;
    const selectionRevision = get().selectionRevision + 1;
    set({ themeId, selectionRevision });
    persist(api, themeId, selectionRevision, {
      getConfirmedThemeId: () => get().confirmedThemeId,
      onPersisted: (persistedThemeId) => set({ confirmedThemeId: persistedThemeId }),
      onReconciled: (authoritativeThemeId, failedRevision) => {
        set((state) => ({
          confirmedThemeId: authoritativeThemeId,
          themeId: state.selectionRevision === failedRevision
            ? authoritativeThemeId
            : state.themeId,
        }));
      },
    });
  },
}));
