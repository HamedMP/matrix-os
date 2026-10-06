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
    parsed.pathname.includes("%")
  )
    return false;
  const slug = appSlugFromName(appName);
  if (slug === "app-gallery") {
    if (url === "/api/app-gallery") return method === "GET";
    if (/^\/api\/app-gallery\/[a-z][a-z0-9-]{0,47}\/install$/.test(url))
      return method === "POST";
    if (
      parsed.pathname === "/api/bridge/service" ||
      parsed.pathname.startsWith("/api/bridge/service/")
    ) {
      return url === "/api/bridge/service" && method === "GET";
    }
    return false;
  }
  if (
    parsed.pathname === "/api/bridge/ai" ||
    parsed.pathname.startsWith("/api/bridge/ai/")
  ) {
    return url === "/api/bridge/ai";
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
