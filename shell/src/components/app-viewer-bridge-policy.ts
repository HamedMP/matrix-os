import { APP_READ_JOB_PATHS } from "./app-read-job-request";
const RESOURCE_MANAGER_ACTIVITY_PATH = /^\/api\/system\/activity(?:[?#]|$)/;

function appSlugFromName(appName: string): string {
  const parts = appName.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? appName;
}

export function isAllowedBridgeFetchUrl(appName: string, url: string): boolean {
  // Reject aliases and encoded paths so app-scoped AI cannot bypass identity binding.
  const parsed = new URL(url, "https://bridge.invalid");
  if (parsed.origin !== "https://bridge.invalid" || parsed.pathname.includes("%")) return false;
  if (parsed.pathname === "/api/app-read-jobs" || parsed.pathname.startsWith("/api/app-read-jobs/")) return APP_READ_JOB_PATHS.includes(url);
  if (parsed.pathname === "/api/bridge/integrations" || parsed.pathname.startsWith("/api/bridge/integrations/")) {
    return url === "/api/bridge/integrations";
  }
  if (parsed.pathname === "/api/bridge/ai" || parsed.pathname.startsWith("/api/bridge/ai/")) {
    return url === "/api/bridge/ai";
  }
  if (url.startsWith("/api/bridge/") && parsed.pathname.startsWith("/api/bridge/")) return true;
  const slug = appSlugFromName(appName);
  if (slug === "resource-manager") return RESOURCE_MANAGER_ACTIVITY_PATH.test(url);
  return false;
}
