const SYMPHONY_API_PATH = /^\/api\/symphony(?:\/|$)/;
const RESOURCE_MANAGER_ACTIVITY_PATH = /^\/api\/system\/activity(?:[?#]|$)/;

function appSlugFromName(appName: string): string {
  const parts = appName.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? appName;
}

export function isAllowedBridgeFetchUrl(appName: string, url: string): boolean {
  if (url.startsWith("/api/bridge/")) return true;
  const slug = appSlugFromName(appName);
  if (slug === "symphony") return SYMPHONY_API_PATH.test(url);
  if (slug === "resource-manager") return RESOURCE_MANAGER_ACTIVITY_PATH.test(url);
  return false;
}
