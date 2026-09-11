import type { MatrixApp } from "../../desktop/src/renderer/src/features/apps/apps.api";
import { appKeys } from "../../desktop/src/renderer/src/features/apps/apps.api";
import { desktopQueryClient } from "../../desktop/src/renderer/src/lib/query-client";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

export function currentAppsQueryKey() {
  const { platformHost, authGeneration, runtimeSlot } = useConnection.getState();
  return appKeys.list({ platformHost, authGeneration, runtimeSlot });
}

export function seedDesktopApps(apps: MatrixApp[]): void {
  desktopQueryClient.setQueryData(currentAppsQueryKey(), apps);
}

export function clearDesktopApps(): void {
  desktopQueryClient.clear();
}
