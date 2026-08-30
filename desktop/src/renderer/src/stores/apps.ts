// Installed Matrix OS apps (GET /api/apps). Loaded at desktop startup and
// shared by the Apps launcher and the command palette so both list the same
// set.
import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";

export interface MatrixApp {
  slug: string;
  name: string;
  path?: string;
  category?: string;
  appIdentity?: string;
}

const SAFE_APP_IDENTITY = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

function appIdentityFromFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const identity = value
    .replace(/^\/+/, "")
    .replace(/\/index\.html$/, "")
    .replace(/\.html$/, "");
  return identity.length <= 256 && SAFE_APP_IDENTITY.test(identity) ? identity : undefined;
}

function appPathFromFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const path = value.replace(/^\/+/, "");
  return path.startsWith("apps/") && !path.split("/").includes("..") ? path : undefined;
}

const MAX_APP_ICON_PRELOADS = 20;
let iconPreloadLinks: HTMLLinkElement[] = [];
let appsLoadInFlight: Promise<void> | null = null;
let appsLoadGeneration = 0;

// Apps resolve their icon through the gateway's /icons/{slug}.png, which falls
// back to shipped assets. Bearer auth is injected by the trusted core for the
// gateway origin, so the renderer can load it directly.
export function appIconUrl(platformHost: string, slug: string, runtimeSlot = "primary"): string | null {
  if (!platformHost) return null;
  const url = `${platformHost.replace(/\/$/, "")}/icons/${encodeURIComponent(slug)}.png`;
  return runtimeSlot === "primary" ? url : `${url}?runtime=${encodeURIComponent(runtimeSlot)}`;
}

/**
 * Retains preload hints for the first Apps-page row set before the page mounts.
 * The capped links make the browser request icons before the user opens Apps.
 */
export function preloadAppIcons(platformHost: string, runtimeSlot: string, apps: readonly MatrixApp[]): void {
  clearPreloadedAppIcons();
  if (typeof document === "undefined") return;
  for (const app of apps.slice(0, MAX_APP_ICON_PRELOADS)) {
    const url = appIconUrl(platformHost, app.slug, runtimeSlot);
    if (!url) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.setAttribute("as", "image");
    link.setAttribute("fetchpriority", "low");
    link.href = url;
    document.head.append(link);
    iconPreloadLinks.push(link);
  }
}

export function resetAppsRuntime(): void {
  clearPreloadedAppIcons();
  appsLoadGeneration += 1;
  useApps.setState({ apps: [], loaded: false, loading: false, error: null });
}

function clearPreloadedAppIcons(): void {
  for (const link of iconPreloadLinks) link.remove();
  iconPreloadLinks = [];
}

export function parseApps(value: unknown): MatrixApp[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : [];
  const apps: MatrixApp[] = [];
  for (const raw of list.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const app = raw as Partial<MatrixApp> & { file?: unknown };
    if (typeof app.slug !== "string" || app.slug.trim().length === 0) continue;
    const slug = app.slug.trim();
    const name = typeof app.name === "string" && app.name.trim().length > 0 ? app.name.trim() : slug;
    const category =
      typeof app.category === "string" && app.category.trim().length > 0 ? app.category.trim() : undefined;
    const appIdentity = appIdentityFromFile(app.file);
    const path = appPathFromFile(app.file);
    apps.push({
      slug,
      name,
      ...(path ? { path } : {}),
      ...(category ? { category } : {}),
      ...(appIdentity ? { appIdentity } : {}),
    });
  }
  return apps;
}

interface AppsState {
  apps: MatrixApp[];
  loaded: boolean;
  loading: boolean;
  error: AppErrorCategory | null;
  load(api: ApiClient, force?: boolean): Promise<void>;
}

export const useApps = create<AppsState>()((set, get) => ({
  apps: [],
  loaded: false,
  loading: false,
  error: null,

  load: async (api, force = false) => {
    if (get().loading) return appsLoadInFlight ?? Promise.resolve();
    if (get().loaded && !force) return;
    set({ loading: true });
    const loadGeneration = appsLoadGeneration;
    const request = (async () => {
      try {
        const res = await api.get<unknown>("/api/apps");
        if (loadGeneration !== appsLoadGeneration) return;
        set({ apps: parseApps(res), loaded: true, loading: false, error: null });
      } catch (err: unknown) {
        if (loadGeneration !== appsLoadGeneration) return;
        set({ loading: false, loaded: true, error: err instanceof AppError ? err.category : "server" });
      }
    })();
    appsLoadInFlight = request;
    try {
      await request;
    } finally {
      if (appsLoadInFlight === request) appsLoadInFlight = null;
    }
  },
}));
