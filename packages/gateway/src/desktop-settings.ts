import { z } from "zod/v4";

const DESKTOP_DEFAULTS = {
  background: { type: "wallpaper", name: "matrix-dusk.webp" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: ["__terminal__", "__file-browser__", "__chat__"] as string[],
};

const RETIRED_DESKTOP_APP_PATHS = new Set(["__workspace__"]);

const DesktopBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pattern") }).strict(),
  z.object({ type: z.literal("solid"), color: z.string().min(1).max(128) }).strict(),
  z.object({
    type: z.literal("gradient"),
    from: z.string().min(1).max(128),
    to: z.string().min(1).max(128),
    angle: z.number().finite().optional(),
  }).strict(),
  z.object({ type: z.literal("wallpaper"), name: z.string().min(1).max(255) }).strict(),
  z.object({
    type: z.literal("image"),
    url: z.string().min(1).max(8192),
    fit: z.string().min(1).max(64).optional(),
  }).strict(),
]);

const DesktopDockPatchSchema = z.object({
  position: z.enum(["left", "right", "bottom"]).optional(),
  size: z.number().int().min(16).max(128).optional(),
  iconSize: z.number().int().min(16).max(128).optional(),
  autoHide: z.boolean().optional(),
}).strict();

const DesktopIconSchema = z.object({
  path: z.string().min(1).max(2048),
  x: z.number().int().min(0).max(16_384),
  y: z.number().int().min(0).max(16_384),
}).strict();

export const DesktopPatchSchema = z.object({
  background: DesktopBackgroundSchema.optional(),
  dock: DesktopDockPatchSchema.optional(),
  pinnedApps: z.array(z.string().min(1).max(2048)).max(512).optional(),
  iconStyle: z.string().min(1).max(128).optional(),
  dockOrder: z.object({
    userApps: z.array(z.string().min(1).max(2048)).max(512).optional(),
    systemApps: z.array(z.string().min(1).max(2048)).max(512).optional(),
  }).strict().optional(),
  desktopIcons: z.array(DesktopIconSchema).max(512).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Patch cannot be empty");

export function mergeDesktopDefaults(config: Record<string, unknown>, additionalDefaults: Record<string, unknown> = {}): Record<string, unknown> {
  const dock = typeof config.dock === "object" && config.dock !== null ? config.dock : {};
  const pinnedApps = Array.isArray(config.pinnedApps)
    ? config.pinnedApps.filter((path): path is string => typeof path === "string" && !RETIRED_DESKTOP_APP_PATHS.has(path))
    : DESKTOP_DEFAULTS.pinnedApps;
  const legacyDesktopImport = {
    ...(Object.prototype.hasOwnProperty.call(config, "pinnedApps")
      ? { pinnedApps: Array.isArray(config.pinnedApps) ? pinnedApps : config.pinnedApps }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(config, "desktopIcons")
      ? { desktopIcons: config.desktopIcons }
      : {}),
  };
  return {
    ...DESKTOP_DEFAULTS,
    ...additionalDefaults,
    ...config,
    dock: { ...DESKTOP_DEFAULTS.dock, ...dock },
    pinnedApps,
    legacyDesktopImport,
  };
}

export function preserveRetiredPinnedApps(
  currentPinnedApps: unknown,
  visiblePinnedApps: unknown,
): string[] {
  const visible = Array.isArray(visiblePinnedApps)
    ? visiblePinnedApps.filter((path): path is string => typeof path === "string")
    : [...DESKTOP_DEFAULTS.pinnedApps];
  const retired = Array.isArray(currentPinnedApps)
    ? currentPinnedApps.filter((path): path is string => (
      typeof path === "string" && RETIRED_DESKTOP_APP_PATHS.has(path)
    ))
    : [];
  return [...visible, ...retired.filter((path) => !visible.includes(path))];
}

export type DesktopSettingsPatch = z.infer<typeof DesktopPatchSchema>;

export function mergeDesktopPatch(current: Record<string, unknown>, patch: DesktopSettingsPatch): Record<string, unknown> {
  const { dock: dockPatch, ...parsedTopLevelPatch } = patch;
  const topLevelPatch = parsedTopLevelPatch.pinnedApps
    ? { ...parsedTopLevelPatch, pinnedApps: preserveRetiredPinnedApps(current.pinnedApps, parsedTopLevelPatch.pinnedApps) }
    : parsedTopLevelPatch;
  const currentDock = current.dock !== null && typeof current.dock === "object" && !Array.isArray(current.dock)
    ? current.dock as Record<string, unknown> : {};
  return { ...current, ...topLevelPatch, ...(dockPatch ? { dock: { ...currentDock, ...dockPatch } } : {}) };
}
