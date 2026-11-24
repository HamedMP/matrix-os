import { isAllowedAppGalleryBridgeRequest, isAppGalleryIdentity, isAppGalleryInventoryIdentity } from "@matrix-os/contracts/app-gallery-bridge-policy";
import { APP_FILES_BRIDGE_PATH } from "@matrix-os/contracts/app-files";

/** Bridge routes that take no subpath, query or fragment. */
const EXACT_BRIDGE_PATHS: readonly string[] = ["/api/bridge/capabilities", "/api/bridge/service", "/api/bridge/query", "/api/bridge/data", APP_FILES_BRIDGE_PATH];
const RESOURCE_MANAGER_ACTIVITY_PATH = /^\/api\/system\/activity(?:[?#]|$)/;

function appSlugFromName(appName: string): string {
  const parts = appName.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? appName;
}

export function isAllowedBridgeFetchUrl(
  appName: string,
  url: string,
  method = "GET",
): boolean {
  // Reject aliases and encoded paths so app-scoped AI cannot bypass identity binding.
  const parsed = new URL(url, "https://bridge.invalid");
  if (
    parsed.origin !== "https://bridge.invalid" ||
    parsed.pathname.includes("%") ||
    parsed.pathname.includes("//")
  )
    return false;
  const slug = appSlugFromName(appName);
  if (isAppGalleryIdentity(appName.replace(/^apps\//, ""), slug)) return isAllowedAppGalleryBridgeRequest(url, method);
  if (url === "/api/integrations")
    return method === "GET" && isAppGalleryInventoryIdentity(appName.replace(/^apps\//, ""), slug);
  if (
    parsed.pathname === "/api/bridge/ai" ||
    parsed.pathname.startsWith("/api/bridge/ai/")
  ) {
    return url === "/api/bridge/ai" || url === "/api/bridge/ai/routes";
  }
  if (EXACT_BRIDGE_PATHS.some((path) => parsed.pathname === path || parsed.pathname.startsWith(`${path}/`))) {
    return url === parsed.pathname && EXACT_BRIDGE_PATHS.includes(url);
  }
  if (
    url.startsWith("/api/bridge/") &&
    parsed.pathname.startsWith("/api/bridge/")
  )
    return true;
  if (slug === "resource-manager")
    return RESOURCE_MANAGER_ACTIVITY_PATH.test(url);
  return false;
}
