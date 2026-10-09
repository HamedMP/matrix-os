import { canonicalOsViewCatalogPath, resolveChatAppReference } from "@matrix-os/contracts";
import { readAppBridgeResponse } from "@/components/app-capability-request";
import { extractSlug } from "@/components/app-viewer-helpers";
import { normalizeAppBridgeLaunchPath } from "./builtin-apps";
import { getGatewayUrl } from "./gateway";
import { resolveWebDesktopBuiltInLaunch } from "./web-desktop-app-launch";

/** Owner folder spellings are references, never runtime or grant identities. */
export async function resolveAppBridgeLaunch(name: string, requestedPath: string, signal: AbortSignal): Promise<{ name: string; path: string }> {
  const explicitIdentity = requestedPath.startsWith("matrix-app:");
  if (explicitIdentity && !/^matrix-app:[a-z0-9][a-z0-9-]{0,63}$/.test(requestedPath)) throw new Error("App launch unavailable");
  const identity = explicitIdentity ? requestedPath.slice(11) : null;
  const normalized = normalizeAppBridgeLaunchPath(requestedPath);
  if (!explicitIdentity && (!normalized.startsWith("apps/") || resolveWebDesktopBuiltInLaunch(normalized))) return { name, path: normalized };
  const gateway = getGatewayUrl();
  const response = await fetch(`${gateway}/api/apps`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!response.ok) throw new Error("App launch unavailable");
  const value = await readAppBridgeResponse(response, { url: "/api/bridge/query", init: {} });
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("App launch unavailable");
  const apps = value.flatMap(row => {
    if (!row || typeof row !== "object" || (row.slug !== undefined && (typeof row.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.slug)))
      || typeof row.name !== "string" || !row.name.trim() || row.name.length > 256) return [];
    const path = canonicalOsViewCatalogPath(row);
    return path ? [{ slug: row.slug ?? "", name: row.name, path }] : [];
  });
  const identities = identity === null ? [] : apps.filter(app => app.slug === identity);
  // An explicit identity cannot fall through to a physical owner folder.
  const app = explicitIdentity ? (identities.length === 1 ? identities[0] : undefined)
    : resolveChatAppReference(requestedPath, apps, { allowRelative: true })
      ?? resolveChatAppReference(requestedPath, apps.filter(app => app.slug).map(app => ({ ...app, ownerPath: app.path, path: `apps/${app.slug}/index.html` })), { allowRelative: true })
      ?? apps.find(candidate => !candidate.slug && candidate.path === normalized);
  if (!app || signal.aborted || getGatewayUrl() !== gateway) throw new Error("App launch unavailable");
  // Preserve only catalog-backed bundled migration identities; other moved
  // folders launch through the stable manifest slug and its bridged loader.
  const ownerPath = "ownerPath" in app && typeof app.ownerPath === "string" ? app.ownerPath : app.path;
  return { name: app.name, path: !app.slug || extractSlug(ownerPath) === app.slug ? ownerPath : `apps/${app.slug}/index.html` };
}
