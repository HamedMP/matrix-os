import type { OsViewMode } from "@matrix-os/contracts";
import type { DesktopSurface, DesktopSurfaceBounds } from "../../stores/desktop-surfaces";

interface SurfaceBoundsEntry extends DesktopSurfaceBounds {
  tabId: string;
}

export type NativeOsViewLayoutMemory = Record<OsViewMode, SurfaceBoundsEntry[] | null>;

export function createNativeOsViewLayoutMemory(): NativeOsViewLayoutMemory {
  return { desktop: null, canvas: null };
}

export function transitionNativeOsViewLayout(
  memory: NativeOsViewLayoutMemory,
  from: OsViewMode,
  to: OsViewMode,
  surfaces: Readonly<Record<string, DesktopSurface>>,
): { memory: NativeOsViewLayoutMemory; surfaces: Record<string, DesktopSurface> } {
  const captured = Object.values(surfaces).map((surface) => ({
    tabId: surface.tabId,
    ...surface.bounds,
  }));
  const nextMemory = { ...memory, [from]: captured };
  const destination = nextMemory[to];
  if (!destination) return { memory: nextMemory, surfaces: { ...surfaces } };

  return {
    memory: nextMemory,
    surfaces: Object.fromEntries(Object.entries(surfaces).map(([tabId, surface]) => {
      const entry = destination.find((candidate) => candidate.tabId === tabId);
      if (!entry) return [tabId, surface];
      return [tabId, {
        ...surface,
        bounds: {
          x: entry.x,
          y: entry.y,
          width: entry.width,
          height: entry.height,
        },
      }];
    })),
  };
}
