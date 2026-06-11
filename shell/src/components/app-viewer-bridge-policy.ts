const SYMPHONY_API_PATH = /^\/api\/symphony(?:\/|$)/;

function appSlugFromName(appName: string): string {
  const parts = appName.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? appName;
}

export function isAllowedBridgeFetchUrl(appName: string, url: string): boolean {
  if (url.startsWith("/api/bridge/")) return true;
  return appSlugFromName(appName) === "symphony" && SYMPHONY_API_PATH.test(url);
}
