// Renderer side of "Install as App" (spec 2711, layer 4). The main process owns
// installs; the renderer reads its list, asks it to install a catalog app by
// reference, and refreshes when it reports a change.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { invoke, onEvent } from "../../lib/operator";
import { desktopQueryClient } from "../../lib/query-client";
import type { MatrixApp } from "../apps/apps.api";
import type { InstallAppErrorCode, InstalledAppPlatform, InstalledAppSummary, InstalledAppsList } from "../../../../shared/installed-apps-ipc";
import type { NativeAppOpenRequest } from "../../../../shared/native-app-open";

export const installedAppsQueryKey = ["installed-apps", "list"] as const;

const EXPLICIT_IDENTITY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Fixed copy for every failure code; nothing from the main process is shown as is. */
export const INSTALL_ERROR_COPY: Record<InstallAppErrorCode, string> = {
  "unavailable": "Installing apps isn’t available right now.",
  "auth-required": "Sign in to Matrix to install apps.",
  "not-found": "This app is no longer available.",
  "limit": "You’ve installed the most apps Matrix allows. Uninstall one and try again.",
  "failed": "Couldn’t finish. Try again.",
};

export function installErrorCopy(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(INSTALL_ERROR_COPY, code)
    ? INSTALL_ERROR_COPY[code as InstallAppErrorCode]
    : INSTALL_ERROR_COPY.failed;
}

/** Where the installed app shows up, for the confirm sheet. */
export const INSTALL_DESTINATION: Record<InstalledAppPlatform, string> = {
  mac: "Adds it to Applications › Matrix Apps, with its own Dock icon.",
  windows: "Adds it to the Start menu, with its own taskbar icon.",
  linux: "Adds it to your apps menu.",
};

export const REVEAL_LABEL: Record<InstalledAppPlatform, string> = {
  mac: "Show in Finder",
  windows: "Show in folder",
  linux: "Show in folder",
};

/** The catalog reference main resolves; the stable app identity when there is one. */
export function installRequestFor(app: Pick<MatrixApp, "slug" | "name" | "path">): NativeAppOpenRequest | null {
  const name = app.name.trim().slice(0, 256) || app.slug;
  if (EXPLICIT_IDENTITY.test(app.slug)) return { name, path: `matrix-app:${app.slug}` };
  return app.path ? { name, path: app.path } : null;
}

export function installedAppFor(
  list: InstalledAppsList | undefined,
  slug: string,
  runtimeSlot: string,
): InstalledAppSummary | null {
  if (!list?.available) return null;
  return list.apps.find((app) => app.slug === slug && app.runtimeSlot === runtimeSlot) ?? null;
}

async function readInstalledApps(): Promise<InstalledAppsList> {
  if (!window.operator) return { available: false };
  try {
    return await invoke("installed-apps:list", {});
  } catch (error: unknown) {
    console.warn("[installed-apps] list unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { available: false };
  }
}

export function refreshInstalledApps(): Promise<void> {
  return desktopQueryClient.invalidateQueries({ queryKey: installedAppsQueryKey });
}

/** The install list; `available: false` hides every install entry. */
export function useInstalledApps(): InstalledAppsList | undefined {
  useEffect(() => {
    // Without the preload bridge (a browser preview) there is nothing to install.
    if (!window.operator) return undefined;
    const offChanged = onEvent("installed-apps:changed", () => { void refreshInstalledApps(); });
    // Availability can settle after the first read (macOS shim startup); focusing the window re-reads it too.
    const offFocus = onEvent("window:focus-changed", ({ focused }) => { if (focused) void refreshInstalledApps(); });
    return () => {
      offChanged();
      offFocus();
    };
  }, []);
  return useQuery({
    queryKey: installedAppsQueryKey,
    queryFn: readInstalledApps,
    staleTime: 30_000,
    retry: false,
  }, desktopQueryClient).data;
}
