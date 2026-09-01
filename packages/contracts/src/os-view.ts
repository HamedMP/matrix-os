import { z } from "zod/v4";

export const OS_VIEW_MODES = ["desktop", "canvas"] as const;
export type OsViewMode = (typeof OS_VIEW_MODES)[number];

export const OS_VIEW_LABELS: Readonly<Record<OsViewMode, "Desktop" | "Canvas">> = {
  desktop: "Desktop",
  canvas: "Canvas",
};

export const OS_VIEW_DESTINATION_PATHS: Readonly<Record<OsViewMode, string>> = {
  desktop: "__os-view-desktop__",
  canvas: "__os-view-canvas__",
};

export const DEFAULT_OS_VIEW_DESKTOP_APP_PATHS = Object.freeze([
  "__chat__",
  "__terminal__",
  "__file-browser__",
  "__editor__",
  "__vscode__",
  "__settings__",
  "__plugins__",
  "__browser__",
  "apps/notes/index.html",
  "apps/whiteboard/index.html",
] as const);

const DEFAULT_DESKTOP_GRID = Object.freeze({
  startX: 20,
  startY: 20,
  columnWidth: 88,
  rowHeight: 92,
  columns: 2,
});

const OS_VIEW_DESKTOP_APP_PATH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "apps/browser/index.html": "__browser__",
  "apps/browser/dist/index.html": "__browser__",
  "__notes__": "apps/notes/index.html",
  "apps/notes/dist/index.html": "apps/notes/index.html",
  "apps/whiteboard/dist/index.html": "apps/whiteboard/index.html",
});

export function normalizeOsViewDesktopAppPath(path: string): string {
  return OS_VIEW_DESKTOP_APP_PATH_ALIASES[path] ?? path;
}

export function normalizeOsViewMode(value: unknown): OsViewMode {
  return value === "canvas" ? "canvas" : "desktop";
}

export function otherOsViewMode(mode: OsViewMode): OsViewMode {
  return mode === "canvas" ? "desktop" : "canvas";
}

export function isOsViewDestinationPath(path: string): boolean {
  return path === OS_VIEW_DESTINATION_PATHS.desktop
    || path === OS_VIEW_DESTINATION_PATHS.canvas;
}

const OsViewPathSchema = z.string().min(1).max(2048);
const OsViewCoordinateSchema = z.number().finite().min(-16_384).max(16_384);
const OsViewDimensionSchema = z.number().finite().min(1).max(16_384);

export const OsViewAppStateSchema = z.object({
  path: OsViewPathSchema,
  title: z.string().min(1).max(256),
  iconKey: z.string().min(1).max(256).optional(),
  state: z.enum(["open", "minimized", "closed"]),
}).strict();

export const OsViewWindowGeometrySchema = z.object({
  path: OsViewPathSchema,
  x: OsViewCoordinateSchema,
  y: OsViewCoordinateSchema,
  width: OsViewDimensionSchema,
  height: OsViewDimensionSchema,
}).strict();

export const OsViewDesktopIconSchema = z.object({
  path: OsViewPathSchema,
  iconKey: z.string().min(1).max(256).optional(),
  x: OsViewCoordinateSchema,
  y: OsViewCoordinateSchema,
}).strict();

export const LegacyDesktopImportSchema = z.object({
  pinnedApps: z.array(OsViewPathSchema).max(512).optional(),
  desktopIcons: z.array(OsViewDesktopIconSchema).max(512).optional(),
}).strict();

export const OsViewCanvasTransformSchema = z.object({
  panX: OsViewCoordinateSchema,
  panY: OsViewCoordinateSchema,
  zoom: z.number().finite().min(0.1).max(4),
}).strict();

export const OsViewDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  apps: z.array(OsViewAppStateSchema).max(512),
  pinnedApps: z.array(OsViewPathSchema).max(512),
  desktop: z.object({
    windows: z.array(OsViewWindowGeometrySchema).max(512),
    icons: z.array(OsViewDesktopIconSchema).max(512),
  }).strict(),
  canvas: z.object({
    windows: z.array(OsViewWindowGeometrySchema).max(512),
    transform: OsViewCanvasTransformSchema,
  }).strict(),
}).strict();

export const OsViewStatePatchSchema = z.object({
  apps: z.array(OsViewAppStateSchema).max(512).optional(),
  pinnedApps: z.array(OsViewPathSchema).max(512).optional(),
  desktop: z.object({
    windows: z.array(OsViewWindowGeometrySchema).max(512).optional(),
    icons: z.array(OsViewDesktopIconSchema).max(512).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Desktop patch cannot be empty").optional(),
  canvas: z.object({
    windows: z.array(OsViewWindowGeometrySchema).max(512).optional(),
    transform: OsViewCanvasTransformSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Canvas patch cannot be empty").optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Patch cannot be empty");

export const OsViewMutationIdSchema = z.string().regex(/^osvm_[a-f0-9]{32}$/);

export const PatchOsViewStateRequestSchema = z.object({
  baseRevision: z.number().int().min(1),
  mutationId: OsViewMutationIdSchema,
  patch: OsViewStatePatchSchema,
}).strict();

export const OsViewStateResponseSchema = z.object({
  revision: z.number().int().min(1),
  document: OsViewDocumentSchema,
  updatedAt: z.string().datetime(),
}).strict();

export type OsViewAppState = z.infer<typeof OsViewAppStateSchema>;
export type OsViewWindowGeometry = z.infer<typeof OsViewWindowGeometrySchema>;
export type OsViewDesktopIcon = z.infer<typeof OsViewDesktopIconSchema>;
export type LegacyDesktopImport = z.infer<typeof LegacyDesktopImportSchema>;
export type OsViewCanvasTransform = z.infer<typeof OsViewCanvasTransformSchema>;
export type OsViewDocument = z.infer<typeof OsViewDocumentSchema>;
export type OsViewStatePatch = z.infer<typeof OsViewStatePatchSchema>;
export type PatchOsViewStateRequest = z.infer<typeof PatchOsViewStateRequestSchema>;
export type OsViewStateResponse = z.infer<typeof OsViewStateResponseSchema>;

export function legacyDesktopImportFromConfig(value: unknown): LegacyDesktopImport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  const candidate = Object.prototype.hasOwnProperty.call(config, "legacyDesktopImport")
    ? config.legacyDesktopImport
    : {
        ...(Object.prototype.hasOwnProperty.call(config, "pinnedApps")
          ? { pinnedApps: config.pinnedApps }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(config, "desktopIcons")
          ? { desktopIcons: config.desktopIcons }
          : {}),
      };
  const parsed = LegacyDesktopImportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizeOsViewDesktopIcons(
  icons: readonly OsViewDesktopIcon[],
): OsViewDesktopIcon[] {
  const normalized: OsViewDesktopIcon[] = [];
  const seen = new Set<string>();
  for (const icon of icons) {
    const path = normalizeOsViewDesktopAppPath(icon.path);
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push({ ...icon, path });
  }
  return normalized;
}

export function createDefaultOsViewDesktopIcons(): OsViewDesktopIcon[] {
  return DEFAULT_OS_VIEW_DESKTOP_APP_PATHS.map((path, index) => ({
    path,
    x: DEFAULT_DESKTOP_GRID.startX + (index % DEFAULT_DESKTOP_GRID.columns) * DEFAULT_DESKTOP_GRID.columnWidth,
    y: DEFAULT_DESKTOP_GRID.startY + Math.floor(index / DEFAULT_DESKTOP_GRID.columns) * DEFAULT_DESKTOP_GRID.rowHeight,
  }));
}

export function createDefaultOsViewDocument(): OsViewDocument {
  return {
    schemaVersion: 1,
    apps: [],
    pinnedApps: [],
    desktop: { windows: [], icons: createDefaultOsViewDesktopIcons() },
    canvas: {
      windows: [],
      transform: { panX: 0, panY: 0, zoom: 1 },
    },
  };
}

export function mergeOsViewStatePatch(
  document: OsViewDocument,
  patch: OsViewStatePatch,
): OsViewDocument {
  return OsViewDocumentSchema.parse({
    ...document,
    ...patch,
    desktop: patch.desktop ? { ...document.desktop, ...patch.desktop } : document.desktop,
    canvas: patch.canvas ? { ...document.canvas, ...patch.canvas } : document.canvas,
  });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rebaseRecord<T extends Record<string, unknown>>(
  base: T,
  latest: T,
  desired: T,
): T {
  const rebased: Record<string, unknown> = { ...latest };
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    if (jsonEqual(base[key], desired[key])) continue;
    if (key in desired) rebased[key] = desired[key];
    else delete rebased[key];
  }
  return rebased as T;
}

function rebasePathCollection<T extends { path: string }>(
  base: readonly T[],
  latest: readonly T[],
  desired: readonly T[],
): T[] {
  const baseByPath = new Map(base.map((entry) => [entry.path, entry]));
  const desiredByPath = new Map(desired.map((entry) => [entry.path, entry]));
  const removedPaths = new Set(
    base.filter((entry) => !desiredByPath.has(entry.path)).map((entry) => entry.path),
  );
  const rebased = latest.filter((entry) => !removedPaths.has(entry.path)).map((entry) => ({ ...entry }));
  const indexByPath = new Map(rebased.map((entry, index) => [entry.path, index]));

  for (const desiredEntry of desired) {
    const baseEntry = baseByPath.get(desiredEntry.path);
    const latestIndex = indexByPath.get(desiredEntry.path);
    const latestEntry = latestIndex === undefined ? undefined : rebased[latestIndex];
    if (baseEntry && jsonEqual(baseEntry, desiredEntry)) continue;

    const nextEntry = baseEntry && latestEntry
      ? rebaseRecord(
        baseEntry as unknown as Record<string, unknown>,
        latestEntry as unknown as Record<string, unknown>,
        desiredEntry as unknown as Record<string, unknown>,
      ) as T
      : { ...desiredEntry };
    if (latestIndex === undefined) {
      indexByPath.set(nextEntry.path, rebased.length);
      rebased.push(nextEntry);
    } else {
      rebased[latestIndex] = nextEntry;
    }
  }

  return rebased;
}

function rebaseStringCollection(
  base: readonly string[],
  latest: readonly string[],
  desired: readonly string[],
): string[] {
  const baseSet = new Set(base);
  const desiredSet = new Set(desired);
  const removed = new Set(base.filter((value) => !desiredSet.has(value)));
  const rebased = latest.filter((value) => !removed.has(value));
  for (const value of desired) {
    if (!baseSet.has(value) && !rebased.includes(value)) rebased.push(value);
  }
  return rebased;
}

/**
 * Reapplies a stale snapshot patch over the latest aggregate after an
 * optimistic-concurrency conflict. Collections merge by canonical path and
 * changed fields, so unrelated edits from another client survive the retry.
 */
export function rebaseOsViewStatePatch(
  base: OsViewDocument,
  latest: OsViewDocument,
  patch: OsViewStatePatch,
): OsViewStatePatch {
  return OsViewStatePatchSchema.parse({
    ...(patch.apps ? {
      apps: rebasePathCollection(base.apps, latest.apps, patch.apps),
    } : {}),
    ...(patch.pinnedApps ? {
      pinnedApps: rebaseStringCollection(base.pinnedApps, latest.pinnedApps, patch.pinnedApps),
    } : {}),
    ...(patch.desktop ? {
      desktop: {
        ...(patch.desktop.windows ? {
          windows: rebasePathCollection(
            base.desktop.windows,
            latest.desktop.windows,
            patch.desktop.windows,
          ),
        } : {}),
        ...(patch.desktop.icons ? {
          icons: rebasePathCollection(
            base.desktop.icons,
            latest.desktop.icons,
            patch.desktop.icons,
          ),
        } : {}),
      },
    } : {}),
    ...(patch.canvas ? {
      canvas: {
        ...(patch.canvas.windows ? {
          windows: rebasePathCollection(
            base.canvas.windows,
            latest.canvas.windows,
            patch.canvas.windows,
          ),
        } : {}),
        ...(patch.canvas.transform ? {
          transform: rebaseRecord(
            base.canvas.transform,
            latest.canvas.transform,
            patch.canvas.transform,
          ),
        } : {}),
      },
    } : {}),
  });
}
