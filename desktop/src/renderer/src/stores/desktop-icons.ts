import { create } from "zustand";
import type { ApiClient } from "../lib/api";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

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
    if (!validPlacement(raw) || seen.has(raw.path)) continue;
    seen.add(raw.path);
    icons.push({ path: raw.path, x: raw.x, y: raw.y });
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
  load(api: ApiClient, defaults: readonly DesktopIconPlacement[]): Promise<void>;
  hydrate(value: unknown, defaults: readonly DesktopIconPlacement[]): void;
  move(path: string, x: number, y: number, api: ApiClient): Promise<void>;
  remove(path: string, api: ApiClient): Promise<void>;
  add(path: string, api: ApiClient): Promise<void>;
}

let loadSequence = 0;
let persistQueue: Promise<void> = Promise.resolve();

export function resetDesktopIconsRuntime(): void {
  loadSequence += 1;
  useDesktopIcons.setState({ icons: [], loaded: false });
}

function persist(api: ApiClient, icons: DesktopIconPlacement[]): Promise<void> {
  const runtimeGeneration = captureRuntimeGeneration();
  const snapshot = icons.map((icon) => ({ ...icon }));
  const write = async () => {
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
    await api.patch("/api/settings/desktop", { desktopIcons: snapshot });
  };
  const pending = persistQueue.then(write, write);
  persistQueue = pending.catch((error: unknown) => {
    console.warn("[desktop-icons] persist queue recovered:", error instanceof Error ? error.name : typeof error);
  });
  return pending.catch((error: unknown) => {
    console.warn("[desktop-icons] persist failed:", error instanceof Error ? error.name : typeof error);
  });
}

export const useDesktopIcons = create<DesktopIconsState>()((set, get) => ({
  icons: [],
  loaded: false,
  hydrate: (value, defaults) => set({
    icons: parseDesktopIcons(value) ?? defaults.map((icon) => ({ ...icon })),
    loaded: true,
  }),
  load: async (api, defaults) => {
    const sequence = ++loadSequence;
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      const config = await api.get<{ desktopIcons?: unknown }>("/api/settings/desktop");
      if (sequence !== loadSequence || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      set({ icons: parseDesktopIcons(config.desktopIcons) ?? defaults.map((icon) => ({ ...icon })), loaded: true });
    } catch (error: unknown) {
      if (sequence !== loadSequence || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.warn("[desktop-icons] load failed:", error instanceof Error ? error.name : typeof error);
      set({ icons: defaults.map((icon) => ({ ...icon })), loaded: true });
    }
  },
  move: async (path, x, y, api) => {
    const next = get().icons.map((icon) => icon.path === path
      ? { ...icon, x: Math.max(0, Math.min(MAX_COORDINATE, Math.round(x))), y: Math.max(0, Math.min(MAX_COORDINATE, Math.round(y))) }
      : icon);
    set({ icons: next });
    await persist(api, next);
  },
  remove: async (path, api) => {
    const next = get().icons.filter((icon) => icon.path !== path);
    set({ icons: next });
    await persist(api, next);
  },
  add: async (path, api) => {
    const current = get().icons;
    if (!path || path.length > 2048 || current.some((icon) => icon.path === path) || current.length >= MAX_DESKTOP_ICONS) return;
    const next = [...current, { path, ...nextOpenSlot(current) }];
    set({ icons: next });
    await persist(api, next);
  },
}));
