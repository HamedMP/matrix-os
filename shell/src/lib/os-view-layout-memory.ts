import type { AppWindow } from "@/hooks/useWindowManager";
import type { DesktopMode } from "@/stores/desktop-mode";

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

/**
 * Keep presentation geometry separate while the canonical window identity,
 * open/minimized state, focus, z-order, and app/session model stay shared.
 */
export function transitionOsViewLayout(
  memory: OsViewLayoutMemory,
  from: DesktopMode,
  to: DesktopMode,
  windows: readonly AppWindow[],
): { memory: OsViewLayoutMemory; windows: AppWindow[] } {
  const nextMemory = { ...memory, [from]: captureGeometry(windows) };
  const destination = nextMemory[to];
  if (!destination) return { memory: nextMemory, windows: [...windows] };

  return {
    memory: nextMemory,
    windows: windows.map((windowRecord) => {
      const geometry = destination.find((entry) => entry.id === windowRecord.id);
      return geometry ? { ...windowRecord, ...geometry } : windowRecord;
    }),
  };
}
