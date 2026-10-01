import { canonicalOsViewCatalogPath, resolveChatAppReference } from "@matrix-os/contracts";
import { NativeAppOpenRequestSchema, NativeAppOpenTargetSchema, type NativeAppOpenRequest, type NativeAppOpenTarget } from "../../shared/native-app-open";
import { readBoundedJson } from "./native-app-bridge";

interface NativeAppOpenResolverOptions {
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  fetchFn?: typeof fetch;
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
      const path = canonicalOsViewCatalogPath(row);
      if (!path?.startsWith("apps/") || !path.endsWith("/index.html")) continue;
      const appIdentity = path.slice(5).replace(/\/(?:dist\/)?index\.html$/, "");
      const target = NativeAppOpenTargetSchema.safeParse({ slug: row.slug, name: row.name, appIdentity });
      if (target.success) apps.push({ ...target.data, path });
    }
    const app = resolveChatAppReference(request.path, apps, { allowRelative: true });
    if (!app) throw new Error("installed app unavailable");
    return { slug: app.slug, name: app.name, appIdentity: app.appIdentity };
  };
}
