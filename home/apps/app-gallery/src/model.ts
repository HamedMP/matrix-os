import { parseGalleryInventory } from "./generated-inventory";
import {
  GalleryAppSchema,
  deriveGalleryReadiness,
  filterGalleryApps,
  type GalleryAppListing,
  type GalleryConnection,
  type GalleryInstallResult,
  type GalleryReadinessStatus,
} from "./generated-contract";
export { deriveGalleryReadiness };
export type { GalleryAppListing, GalleryConnection, GalleryReadinessStatus };
export interface GalleryBridge {
  gatewayFetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs?: number,
  ) => Promise<unknown>;
  integrations?: () => Promise<unknown>;
  openApp?: (name: string, path: string) => void | Promise<unknown>;
}
export interface GalleryFilters {
  collection: "personal" | "business";
  query: string;
  category: string;
  readiness: GalleryReadinessStatus | "all" | "installed";
}
const safeId = /^[a-z][a-z0-9-]{0,47}$/;
const safePath = (value: unknown): value is string =>
  typeof value === "string" && /^apps\/[a-z][a-z0-9-]{0,47}$/.test(value);
export function parseListing(raw: unknown): GalleryAppListing[] {
  if (!raw || typeof raw !== "object") throw new Error("Gallery unavailable");
  const input = raw as { version?: unknown; apps?: unknown };
  if (
    input.version !== 1 ||
    !Array.isArray(input.apps) ||
    input.apps.length > 30
  )
    throw new Error("Gallery unavailable");
  const apps = input.apps.map((value) => {
    if (!value || typeof value !== "object")
      throw new Error("Gallery unavailable");
    const { installed, launchPath, installedName, ...definition } =
      value as Record<string, unknown>;
    const app = GalleryAppSchema.safeParse(definition);
    if (!app.success || typeof installed !== "boolean")
      throw new Error("Gallery unavailable");
    if (
      launchPath !== undefined &&
      (!safePath(launchPath) || launchPath !== `apps/${app.data.id}`)
    )
      throw new Error("Gallery unavailable");
    if (
      installedName !== undefined &&
      (typeof installedName !== "string" ||
        !installedName.trim() ||
        installedName.length > 32768)
    )
      throw new Error("Gallery unavailable");
    return {
      ...app.data,
      installed,
      ...(safePath(launchPath) ? { launchPath } : {}),
      ...(typeof installedName === "string" ? { installedName: installedName.slice(0, 200) } : {}),
    };
  });
  if (new Set(apps.map((app) => app.id)).size !== apps.length)
    throw new Error("Gallery unavailable");
  return apps;
}
export function visibleApps(
  apps: readonly GalleryAppListing[],
  filter: GalleryFilters,
  connections: GalleryConnection[] | null,
) {
  return filterGalleryApps(apps, filter).filter(
    (app) =>
      filter.readiness === "all" ||
      (filter.readiness === "installed"
        ? app.installed
        : deriveGalleryReadiness(app, connections).status === filter.readiness),
  );
}
export async function loadGallery(bridge: GalleryBridge) {
  const [catalog, inventory] = await Promise.allSettled([
    bridge.gatewayFetch("/api/app-gallery"),
    bridge.integrations
      ? bridge.integrations()
      : Promise.reject(new Error("Inventory unavailable")),
  ]);
  if (catalog.status === "rejected") throw new Error("Gallery unavailable");
  if (inventory.status === "rejected")
    console.warn("Gallery connection inventory unavailable");
  return {
    apps: parseListing(catalog.value),
    connections:
      inventory.status === "fulfilled" ? knownInventory(inventory.value) : null,
  };
}
export async function installGalleryApp(
  bridge: GalleryBridge,
  id: string,
): Promise<GalleryInstallResult> {
  if (!safeId.test(id)) throw new Error("Installation unavailable");
  try {
    const raw = await bridge.gatewayFetch(
      `/api/app-gallery/${id}/install`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      35000,
    );
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid installation");
    const result = raw as GalleryInstallResult;
    if (
      !["installed", "already_installed"].includes(result.status) ||
      result.slug !== id ||
      !safePath(result.path) ||
      result.path !== `apps/${id}` ||
      typeof result.name !== "string" ||
      !result.name.trim() ||
      result.name.length > 32768
    )
      throw new Error("Invalid installation");
    return { ...result, name: result.name.slice(0, 200) };
  } catch (error) {
    console.warn(
      "Gallery installation failed",
      error instanceof Error ? error.name : "Unknown error",
    );
    throw new Error("Installation unavailable");
  }
}
export async function openGalleryApp(
  bridge: GalleryBridge,
  app: GalleryAppListing,
) {
  if (!bridge.openApp || !app.installed || !safePath(app.launchPath))
    throw new Error("App unavailable");
  await bridge.openApp(app.installedName ?? app.name, app.launchPath);
}

function knownInventory(raw: unknown): GalleryConnection[] | null {
  try {
    return parseGalleryInventory(raw);
  } catch (cause) {
    console.warn("Gallery connection inventory unavailable", cause);
    return null;
  }
}
