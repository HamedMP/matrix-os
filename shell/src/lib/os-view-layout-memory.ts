import type { AppWindow } from "@/hooks/useWindowManager";
import type { DesktopMode } from "@/stores/desktop-mode";
import { desktopWorkArea } from "@/lib/desktop-work-area";

type WindowGeometry = Pick<AppWindow, "x" | "y" | "width" | "height">;
interface WindowGeometryEntry extends WindowGeometry {
  id: string;
}

export type OsViewLayoutMemory = Record<DesktopMode, WindowGeometryEntry[] | null>;

export function createOsViewLayoutMemory(): OsViewLayoutMemory {
  return { desktop: null, canvas: null };
}

function captureGeometry(windows: readonly AppWindow[]): WindowGeometryEntry[] {
  return windows.map((windowRecord) => ({
    id: windowRecord.id,
    x: windowRecord.x,
    y: windowRecord.y,
    width: windowRecord.width,
    height: windowRecord.height,
  }));
}

export function fitPreviewToDesktopWorkArea<T extends WindowGeometry>(
  geometry: T,
  viewport: { width: number; height: number },
  center = false,
): T {
  const area = desktopWorkArea(viewport, true);
  const width = Math.min(geometry.width, area.width);
  const height = Math.min(geometry.height, area.height);
  const x = center ? Math.round((area.width - width) / 2) : Math.min(Math.max(0, geometry.x), area.width - width);
  const y = center ? Math.round((area.height - height) / 2) : Math.min(Math.max(0, geometry.y), area.height - height);
  return { ...geometry, x, y, width, height };
}

/**
 * Keep presentation geometry separate while the canonical window identity,
 * open/minimized state, focus, z-order, and app/session model stay shared.
 */
export function transitionOsViewLayout(
  memory: OsViewLayoutMemory,
  from: DesktopMode,
  to: DesktopMode,
  windows: readonly AppWindow[],
  viewport: { width: number; height: number },
): { memory: OsViewLayoutMemory; windows: AppWindow[] } {
  const nextMemory = { ...memory, [from]: captureGeometry(windows) };
  const destination = nextMemory[to];

  return {
    memory: nextMemory,
    windows: windows.map((windowRecord) => {
      const geometry = destination?.find((entry) => entry.id === windowRecord.id);
      const restored = geometry ? { ...windowRecord, ...geometry } : windowRecord;
      if (to !== "desktop" || windowRecord.path !== "__preview-window__") return restored;

      // Canvas can place Preview far to the right. Center its first Desktop
      // layout and bring any previously clipped placement fully into view.
      return fitPreviewToDesktopWorkArea(restored, viewport, !geometry);
    }),
  };
}
