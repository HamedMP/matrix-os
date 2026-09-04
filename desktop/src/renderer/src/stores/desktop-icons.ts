import { create } from "zustand";
import type { ApiClient } from "../lib/api";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";
import {
  OsViewStateConflictExhaustedError,
  patchNativeOsViewState,
  primeNativeOsViewState,
  resetNativeOsViewStateClientForTests,
} from "../lib/os-view-state-client";
import {
  createDefaultOsViewDocument,
  normalizeOsViewDesktopAppPath,
  OsViewStateResponseSchema,
} from "@matrix-os/contracts";

export interface DesktopIconPlacement {
  path: string;
  x: number;
  y: number;
}

const MAX_DESKTOP_ICONS = 512;
const MAX_COORDINATE = 16_384;
const GRID_X = 88;
const GRID_Y = 92;
const GRID_COLUMNS = 2;
const START_X = 20;
const START_Y = 20;
const ICON_CONFLICT_RETRY_MS = 2_000;

function validPlacement(value: unknown): value is DesktopIconPlacement {
  if (!value || typeof value !== "object") return false;
  const icon = value as Partial<DesktopIconPlacement>;
  return typeof icon.path === "string"
    && icon.path.length > 0
    && icon.path.length <= 2048
    && Number.isInteger(icon.x)
    && Number.isInteger(icon.y)
    && icon.x! >= 0
    && icon.y! >= 0
    && icon.x! <= MAX_COORDINATE
    && icon.y! <= MAX_COORDINATE;
}

export function parseDesktopIcons(value: unknown): DesktopIconPlacement[] | null {
  if (!Array.isArray(value)) return null;
  const icons: DesktopIconPlacement[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_DESKTOP_ICONS)) {
    if (!validPlacement(raw)) continue;
    const path = normalizeOsViewDesktopAppPath(raw.path);
    if (seen.has(path)) continue;
    seen.add(path);
    icons.push({ path, x: raw.x, y: raw.y });
  }
  return icons;
}

export function defaultDesktopIcons(paths: readonly string[]): DesktopIconPlacement[] {
  return paths.slice(0, MAX_DESKTOP_ICONS).map((path, index) => ({
    path,
    x: START_X + (index % GRID_COLUMNS) * GRID_X,
    y: START_Y + Math.floor(index / GRID_COLUMNS) * GRID_Y,
  }));
}

function nextOpenSlot(icons: readonly DesktopIconPlacement[]): Pick<DesktopIconPlacement, "x" | "y"> {
  const occupied = new Set(icons.map((icon) => `${icon.x}:${icon.y}`));
  for (let index = 0; index < MAX_DESKTOP_ICONS; index += 1) {
    const candidate = {
      x: START_X + (index % GRID_COLUMNS) * GRID_X,
      y: START_Y + Math.floor(index / GRID_COLUMNS) * GRID_Y,
    };
    if (!occupied.has(`${candidate.x}:${candidate.y}`)) return candidate;
  }
  return { x: START_X, y: START_Y };
}

interface DesktopIconsState {
  icons: DesktopIconPlacement[];
  loaded: boolean;
  prime(defaults: readonly DesktopIconPlacement[]): void;
  load(api: ApiClient, defaults: readonly DesktopIconPlacement[]): Promise<void>;
  hydrate(value: unknown, defaults: readonly DesktopIconPlacement[], expectedRevision: number): void;
  move(path: string, x: number, y: number, api: ApiClient): Promise<void>;
  remove(path: string, api: ApiClient): Promise<void>;
  add(path: string, api: ApiClient): Promise<void>;
}

let loadSequence = 0;
let persistQueue: Promise<void> = Promise.resolve();
let mutationSequence = 0;
let stateEpoch = 0;
let hydrationRevision = 0;
let pendingMutationCount = 0;
let confirmedIcons: DesktopIconPlacement[] = [];
let hasConfirmedIcons = false;
let unconfirmedHydrationRevision: number | null = null;
let unconfirmedRollbackIcons: DesktopIconPlacement[] | null = null;
let deferredHydrationIcons: DesktopIconPlacement[] | null = null;
let replayableHydrationRange: { min: number; max: number } | null = null;

function copyIcons(icons: readonly DesktopIconPlacement[]): DesktopIconPlacement[] {
  return icons.map((icon) => ({ ...icon }));
}

export function resetDesktopIconsRuntime(): void {
  resetNativeOsViewStateClientForTests();
  loadSequence += 1;
  mutationSequence += 1;
  stateEpoch += 1;
  hydrationRevision += 1;
  pendingMutationCount = 0;
  confirmedIcons = [];
  hasConfirmedIcons = false;
  unconfirmedHydrationRevision = null;
  unconfirmedRollbackIcons = null;
  deferredHydrationIcons = null;
  replayableHydrationRange = null;
  useDesktopIcons.setState({ icons: [], loaded: false });
}

export function captureDesktopIconsHydrationRevision(): number {
  return hydrationRevision;
}

function persist(api: ApiClient, icons: DesktopIconPlacement[]): Promise<void> {
  const runtimeGeneration = captureRuntimeGeneration();
  const snapshot = icons.map((icon) => ({ ...icon }));
  const write = async () => {
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
    await patchNativeOsViewState(api, { desktop: { icons: snapshot } });
  };
  const pending = persistQueue.then(write, write);
  persistQueue = pending.catch((error: unknown) => {
    console.warn("[desktop-icons] persist queue recovered:", error instanceof Error ? error.name : typeof error);
  });
  return pending;
}

function waitForIconConflictRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ICON_CONFLICT_RETRY_MS));
}

async function retryCurrentIconsAfterConflict(input: {
  api: ApiClient;
  sequence: number;
  epoch: number;
  runtimeGeneration: number;
}): Promise<DesktopIconPlacement[] | null> {
  while (input.epoch === stateEpoch
    && input.sequence === mutationSequence
    && isCurrentRuntimeGeneration(input.runtimeGeneration)) {
    await waitForIconConflictRetry();
    if (input.epoch !== stateEpoch
      || input.sequence !== mutationSequence
      || !isCurrentRuntimeGeneration(input.runtimeGeneration)) return null;
    const latest = copyIcons(useDesktopIcons.getState().icons);
    try {
      await persist(input.api, latest);
      return latest;
    } catch (error: unknown) {
      console.warn("[desktop-icons] conflict retry failed:", error instanceof Error ? error.name : typeof error);
      if (!(error instanceof OsViewStateConflictExhaustedError)) throw error;
    }
  }
  return null;
}

async function applyOptimisticMutation(
  api: ApiClient,
  previousIcons: DesktopIconPlacement[],
  icons: DesktopIconPlacement[],
  set: (partial: Partial<DesktopIconsState>) => void,
): Promise<void> {
  const sequence = ++mutationSequence;
  const epoch = stateEpoch;
  pendingMutationCount += 1;
  const runtimeGeneration = captureRuntimeGeneration();
  const rollbackIcons = copyIcons(previousIcons);
  const snapshot = copyIcons(icons);
  if (!hasConfirmedIcons && unconfirmedHydrationRevision === null) {
    unconfirmedHydrationRevision = hydrationRevision;
    unconfirmedRollbackIcons = copyIcons(previousIcons);
    replayableHydrationRange = null;
  }
  hydrationRevision += 1;
  set({ icons: snapshot, loaded: true });
  let restoredPendingHydration = false;
  try {
    await persist(api, snapshot);
    if (epoch === stateEpoch && sequence <= mutationSequence && isCurrentRuntimeGeneration(runtimeGeneration)) {
      confirmedIcons = copyIcons(snapshot);
      hasConfirmedIcons = true;
      unconfirmedHydrationRevision = null;
      unconfirmedRollbackIcons = null;
      deferredHydrationIcons = null;
      replayableHydrationRange = null;
    }
  } catch (error: unknown) {
    console.warn("[desktop-icons] persist failed:", error instanceof Error ? error.name : typeof error);
    if (error instanceof OsViewStateConflictExhaustedError
      && epoch === stateEpoch
      && sequence === mutationSequence
      && isCurrentRuntimeGeneration(runtimeGeneration)) {
      const persistedIcons = await retryCurrentIconsAfterConflict({
        api,
        sequence,
        epoch,
        runtimeGeneration,
      });
      if (persistedIcons
        && epoch === stateEpoch
        && sequence === mutationSequence
        && isCurrentRuntimeGeneration(runtimeGeneration)) {
        confirmedIcons = copyIcons(persistedIcons);
        hasConfirmedIcons = true;
        unconfirmedHydrationRevision = null;
        unconfirmedRollbackIcons = null;
        deferredHydrationIcons = null;
        replayableHydrationRange = null;
      }
      return;
    }
    if (epoch === stateEpoch && sequence === mutationSequence && isCurrentRuntimeGeneration(runtimeGeneration)) {
      if (deferredHydrationIcons !== null) {
        const icons = copyIcons(deferredHydrationIcons);
        confirmedIcons = copyIcons(icons);
        hasConfirmedIcons = true;
        unconfirmedHydrationRevision = null;
        unconfirmedRollbackIcons = null;
        deferredHydrationIcons = null;
        replayableHydrationRange = null;
        hydrationRevision += 1;
        set({ icons, loaded: true });
        restoredPendingHydration = true;
      } else if (hasConfirmedIcons) {
        set({ icons: copyIcons(confirmedIcons), loaded: true });
      } else {
        set({ icons: copyIcons(unconfirmedRollbackIcons ?? rollbackIcons), loaded: false });
        if (unconfirmedHydrationRevision !== null) {
          replayableHydrationRange = {
            min: unconfirmedHydrationRevision,
            max: hydrationRevision,
          };
          hydrationRevision = unconfirmedHydrationRevision;
          unconfirmedHydrationRevision = null;
          unconfirmedRollbackIcons = null;
          restoredPendingHydration = true;
        }
      }
    }
  } finally {
    if (epoch === stateEpoch) {
      pendingMutationCount = Math.max(0, pendingMutationCount - 1);
      if (!restoredPendingHydration) hydrationRevision += 1;
    }
  }
}

export const useDesktopIcons = create<DesktopIconsState>()((set, get) => ({
  icons: [],
  loaded: false,
  prime: (defaults) => {
    if (get().loaded || get().icons.length > 0) return;
    set({ icons: copyIcons(defaults) });
  },
  hydrate: (value, defaults, expectedRevision) => {
    const icons = parseDesktopIcons(value) ?? copyIcons(defaults);
    const replayable = replayableHydrationRange !== null
      && expectedRevision >= replayableHydrationRange.min
      && expectedRevision <= replayableHydrationRange.max;
    if (!replayable && pendingMutationCount > 0 && expectedRevision === hydrationRevision) {
      deferredHydrationIcons = copyIcons(icons);
      return;
    }
    if (!replayable
      && !hasConfirmedIcons
      && unconfirmedHydrationRevision !== null
      && expectedRevision >= unconfirmedHydrationRevision
      && expectedRevision <= hydrationRevision) {
      deferredHydrationIcons = copyIcons(icons);
      return;
    }
    if (!replayable && expectedRevision !== hydrationRevision) {
      return;
    }
    mutationSequence += 1;
    stateEpoch += 1;
    hydrationRevision += 1;
    confirmedIcons = copyIcons(icons);
    hasConfirmedIcons = true;
    unconfirmedHydrationRevision = null;
    unconfirmedRollbackIcons = null;
    deferredHydrationIcons = null;
    replayableHydrationRange = null;
    set({ icons, loaded: true });
  },
  load: async (api, defaults) => {
    const sequence = ++loadSequence;
    const expectedHydrationRevision = hydrationRevision;
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      const config = await api.get<unknown>("/api/os-view-state");
      if (sequence !== loadSequence
        || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      const parsedState = OsViewStateResponseSchema.safeParse(config);
      const legacyIcons = config && typeof config === "object"
        ? (config as { desktopIcons?: unknown }).desktopIcons
        : undefined;
      const icons = parseDesktopIcons(parsedState.success ? parsedState.data.document.desktop.icons : legacyIcons)
        ?? copyIcons(defaults);
      primeNativeOsViewState(api, parsedState.success ? parsedState.data : {
        revision: 1,
        document: { ...createDefaultOsViewDocument(), desktop: { windows: [], icons } },
        updatedAt: new Date(0).toISOString(),
      });
      const replayable = replayableHydrationRange !== null
        && expectedHydrationRevision >= replayableHydrationRange.min
        && expectedHydrationRevision <= replayableHydrationRange.max;
      if (!replayable && pendingMutationCount > 0 && expectedHydrationRevision === hydrationRevision) {
        deferredHydrationIcons = copyIcons(icons);
        return;
      }
      if (!replayable
        && !hasConfirmedIcons
        && unconfirmedHydrationRevision !== null
        && expectedHydrationRevision >= unconfirmedHydrationRevision
        && expectedHydrationRevision <= hydrationRevision) {
        deferredHydrationIcons = copyIcons(icons);
        return;
      }
      if (!replayable && expectedHydrationRevision !== hydrationRevision) {
        return;
      }
      mutationSequence += 1;
      stateEpoch += 1;
      hydrationRevision += 1;
      confirmedIcons = copyIcons(icons);
      hasConfirmedIcons = true;
      unconfirmedHydrationRevision = null;
      unconfirmedRollbackIcons = null;
      deferredHydrationIcons = null;
      replayableHydrationRange = null;
      set({ icons, loaded: true });
    } catch (error: unknown) {
      if (sequence !== loadSequence
        || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.warn("[desktop-icons] load failed:", error instanceof Error ? error.name : typeof error);
      const icons = copyIcons(defaults);
      const replayable = replayableHydrationRange !== null
        && expectedHydrationRevision >= replayableHydrationRange.min
        && expectedHydrationRevision <= replayableHydrationRange.max;
      if (!replayable && pendingMutationCount > 0 && expectedHydrationRevision === hydrationRevision) {
        deferredHydrationIcons = copyIcons(icons);
        return;
      }
      if (!replayable
        && !hasConfirmedIcons
        && unconfirmedHydrationRevision !== null
        && expectedHydrationRevision >= unconfirmedHydrationRevision
        && expectedHydrationRevision <= hydrationRevision) {
        deferredHydrationIcons = copyIcons(icons);
        return;
      }
      if (!replayable && expectedHydrationRevision !== hydrationRevision) {
        return;
      }
      mutationSequence += 1;
      stateEpoch += 1;
      hydrationRevision += 1;
      confirmedIcons = copyIcons(icons);
      hasConfirmedIcons = true;
      unconfirmedHydrationRevision = null;
      unconfirmedRollbackIcons = null;
      deferredHydrationIcons = null;
      replayableHydrationRange = null;
      set({ icons, loaded: true });
    }
  },
  move: async (path, x, y, api) => {
    const current = get().icons;
    const next = current.map((icon) => icon.path === path
      ? { ...icon, x: Math.max(0, Math.min(MAX_COORDINATE, Math.round(x))), y: Math.max(0, Math.min(MAX_COORDINATE, Math.round(y))) }
      : icon);
    await applyOptimisticMutation(api, current, next, set);
  },
  remove: async (path, api) => {
    const current = get().icons;
    const next = current.filter((icon) => icon.path !== path);
    await applyOptimisticMutation(api, current, next, set);
  },
  add: async (path, api) => {
    const current = get().icons;
    if (!path || path.length > 2048 || current.some((icon) => icon.path === path) || current.length >= MAX_DESKTOP_ICONS) return;
    const next = [...current, { path, ...nextOpenSlot(current) }];
    await applyOptimisticMutation(api, current, next, set);
  },
}));
