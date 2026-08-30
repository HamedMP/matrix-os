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
