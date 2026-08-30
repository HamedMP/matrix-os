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
export type OsViewCanvasTransform = z.infer<typeof OsViewCanvasTransformSchema>;
export type OsViewDocument = z.infer<typeof OsViewDocumentSchema>;
export type OsViewStatePatch = z.infer<typeof OsViewStatePatchSchema>;
export type PatchOsViewStateRequest = z.infer<typeof PatchOsViewStateRequestSchema>;
export type OsViewStateResponse = z.infer<typeof OsViewStateResponseSchema>;

export function createDefaultOsViewDocument(): OsViewDocument {
  return {
    schemaVersion: 1,
    apps: [],
    pinnedApps: [],
    desktop: { windows: [], icons: [] },
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
