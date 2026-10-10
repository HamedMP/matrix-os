import { AppIdentitySchema, appRuntimeSlugFromIdentity, canonicalOsViewCatalogPath, resolveChatAppReference } from "@matrix-os/contracts";
import { NativeAppOpenRequestSchema, NativeAppOpenTargetSchema, type NativeAppOpenRequest, type NativeAppOpenTarget } from "../../shared/native-app-open";
import { readBoundedJson } from "./native-app-bridge";

interface NativeAppOpenResolverOptions {
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  fetchFn?: typeof fetch;
}

/** Validate long runtime catalog roots independently of shorter persisted OS-view paths. */
function runtimeCatalogPath(row: { path?: unknown; file?: unknown }): string | null {
  const desktopPath = canonicalOsViewCatalogPath(row);
  if (desktopPath) return desktopPath;
  for (const [value, fromFile] of [[row.path, false], [row.file, true]] as const) {
    if (typeof value !== "string" || value.length > 4128) continue;
    let path = value.trim().replace(/^\/+/, "").replace(/^files\//, "");
    if (fromFile && !path.startsWith("apps/")) path = `apps/${path}`;
    if (!path.endsWith("/index.html")) continue;
    const root = path.replace(/\/(?:dist\/)?index\.html$/, "");
    if (root.split("/").length > 17) continue;
    if (NativeAppOpenRequestSchema.safeParse({ name: "Installed app", path: root }).success) return path;
  }
  return null;
}

/** Resolve only installed app roots/entries; names are catalog-owned metadata. */
export function createNativeAppOpenResolver(options: NativeAppOpenResolverOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  return async (rawRequest: NativeAppOpenRequest): Promise<NativeAppOpenTarget> => {
    const request = NativeAppOpenRequestSchema.parse(rawRequest);
    const token = options.getToken();
    if (!token) throw new Error("desktop authentication required");
    const origin = new URL(options.getGatewayOrigin());
    if (!["http:", "https:"].includes(origin.protocol)) throw new Error("invalid gateway origin");
    const response = await fetchFn(new URL("/api/apps", origin).toString(), {
      method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("app catalog unavailable");
    const value = await readBoundedJson(response);
    const rows = Array.isArray(value) ? value : value && typeof value === "object" && "apps" in value ? value.apps : null;
    if (!Array.isArray(rows) || rows.length > 10_000) throw new Error("invalid app catalog");
    const apps: Array<NativeAppOpenTarget & { path: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const path = runtimeCatalogPath(row);
      if (!path?.startsWith("apps/") || !path.endsWith("/index.html")) continue;
      const folderIdentity = path.slice(5).replace(/\/(?:dist\/)?index\.html$/, "");
      const parsedFolder = AppIdentitySchema.safeParse(folderIdentity);
      const appIdentity = parsedFolder.success && appRuntimeSlugFromIdentity(parsedFolder.data) === row.slug
        ? parsedFolder.data : row.slug;
      const target = NativeAppOpenTargetSchema.safeParse({ slug: row.slug, name: row.name, appIdentity });
      if (target.success) apps.push({ ...target.data, path });
    }
    const identity = request.path.startsWith("matrix-app:") ? request.path.slice(11) : null;
    const identities = identity === null ? [] : apps.filter(app => app.slug === identity);
    // Explicit identities must never fall through to an owner folder match.
    const app = identity !== null ? (identities.length === 1 ? identities[0] : undefined)
      : resolveChatAppReference(request.path, apps, { allowRelative: true })
        ?? resolveChatAppReference(request.path, apps.map(app => ({ ...app, path: `apps/${app.slug}/index.html` })), { allowRelative: true });
    if (!app) throw new Error("installed app unavailable");
    return { slug: app.slug, name: app.name, appIdentity: app.appIdentity };
  };
}
