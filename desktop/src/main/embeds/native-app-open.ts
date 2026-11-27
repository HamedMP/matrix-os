import { canonicalAppRuntimeCatalogPath } from "@matrix-os/contracts/app-gallery-bridge-policy";
import { AppIdentitySchema, appRuntimeSlugFromIdentity, resolveChatAppReference } from "@matrix-os/contracts";
import { NativeAppOpenRequestSchema, NativeAppOpenTargetSchema, type NativeAppOpenRequest, type NativeAppOpenTarget } from "../../shared/native-app-open";
import { readBoundedJson } from "./native-app-bridge";

export type NativeAppOpenFailure = "auth-required" | "catalog-unavailable" | "not-found";

/** Typed so callers can show the right state without matching on messages. */
export class NativeAppOpenError extends Error {
  constructor(readonly reason: NativeAppOpenFailure, message: string) {
    super(message);
    this.name = "NativeAppOpenError";
  }
}

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
    if (!token) throw new NativeAppOpenError("auth-required", "desktop authentication required");
    const origin = new URL(options.getGatewayOrigin());
    if (!["http:", "https:"].includes(origin.protocol)) throw new Error("invalid gateway origin");
    let rows: unknown;
    try {
      const response = await fetchFn(new URL("/api/apps", origin).toString(), {
        method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) throw new NativeAppOpenError("auth-required", "desktop authentication required");
      if (!response.ok) throw new Error("app catalog unavailable");
      const value = await readBoundedJson(response);
      rows = Array.isArray(value) ? value : value && typeof value === "object" && "apps" in value ? value.apps : null;
    } catch (error: unknown) {
      if (error instanceof NativeAppOpenError) throw error;
      console.warn("[native-app-open] app catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new NativeAppOpenError("catalog-unavailable", "app catalog unavailable");
    }
    if (!Array.isArray(rows) || rows.length > 10_000) throw new NativeAppOpenError("catalog-unavailable", "invalid app catalog");
    const apps: Array<NativeAppOpenTarget & { path: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const path = canonicalAppRuntimeCatalogPath(row);
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
    if (!app) throw new NativeAppOpenError("not-found", "installed app unavailable");
    return { slug: app.slug, name: app.name, appIdentity: app.appIdentity };
  };
}
