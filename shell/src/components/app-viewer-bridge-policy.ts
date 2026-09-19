const SYMPHONY_API_PATH = /^\/api\/symphony(?:\/|$)/;
const RESOURCE_MANAGER_ACTIVITY_PATH = /^\/api\/system\/activity(?:[?#]|$)/;

function appSlugFromName(appName: string): string {
  const parts = appName.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? appName;
}

export function isAllowedBridgeFetchUrl(appName: string, url: string): boolean {
  // Reject aliases and encoded paths so app-scoped AI cannot bypass identity binding.
  const parsed = new URL(url, "https://bridge.invalid");
  if (parsed.origin !== "https://bridge.invalid" || parsed.pathname.includes("%")) return false;
  if (parsed.pathname === "/api/bridge/ai" || parsed.pathname.startsWith("/api/bridge/ai/")) {
    return url === "/api/bridge/ai";
  }
  if (url.startsWith("/api/bridge/") && parsed.pathname.startsWith("/api/bridge/")) return true;
  const slug = appSlugFromName(appName);
  if (slug === "symphony") return SYMPHONY_API_PATH.test(url);
  if (slug === "resource-manager") return RESOURCE_MANAGER_ACTIVITY_PATH.test(url);
  return false;
}
