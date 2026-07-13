import type { LayoutWindow } from "@/hooks/useWindowManager";

export const DESKTOP_GATEWAY_FETCH_TIMEOUT_MS = 10_000;

export interface ModuleRegistryEntry {
  name: string;
  type: string;
  path: string;
  status: string;
}

export interface ModuleMeta {
  name: string;
  entry?: string;
  entryPoint?: string;
  icon?: string;
  version?: string;
}

export interface ShellBootstrapIcon {
  url: string;
  etag: string | null;
  versionedUrl: string;
}

export interface ShellBootstrap {
  layout?: { windows?: LayoutWindow[] };
  modules?: ModuleRegistryEntry[];
  apps?: { name: string; path: string; icon?: string; slug?: string }[];
  icons?: Record<string, ShellBootstrapIcon>;
}

function iconAssetPath(iconUrl: string | undefined): string | undefined {
  if (!iconUrl) return undefined;
  try {
    const base = typeof window === "undefined" ? "http://matrix.local" : window.location.origin;
    return new URL(iconUrl, base).pathname;
  } catch (_err: unknown) {
    return iconUrl.split("?")[0];
  }
}

export function sameIconAsset(left: string | undefined, right: string | undefined): boolean {
  return iconAssetPath(left) === iconAssetPath(right);
}

export function gatewayFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DESKTOP_GATEWAY_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// Forgiving app-name lookup used by vocal mode's `open_app` tool and the
// auto-open after a build finishes. Handles exact, substring, reverse
// substring, and word-level matches so "notes", "the notes", "notes app",
// and "my notes" all resolve to the same installed app.
export function findAppByName<T extends { name: string }>(apps: T[], query: string): T | null {
  const q = query.toLowerCase().trim().replace(/[^\w\s]+/g, "").replace(/\s+/g, " ");
  if (!q) return null;

  const exact = apps.find((a) => a.name.toLowerCase() === q);
  if (exact) return exact;

  // Query is contained in app name; prefer shortest match (most specific).
  const contains = apps.filter((a) => a.name.toLowerCase().includes(q));
  if (contains.length > 0) {
    return contains.reduce((best, a) => (a.name.length < best.name.length ? a : best));
  }

  // App name is contained in query ("open the notes app" contains "Notes");
  // prefer longest.
  const reverse = apps.filter((a) => q.includes(a.name.toLowerCase()));
  if (reverse.length > 0) {
    return reverse.reduce((best, a) => (a.name.length > best.name.length ? a : best));
  }

  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 0) {
    const scored = apps
      .reduce<{ app: T; score: number }[]>((acc, a) => {
        const nameLower = a.name.toLowerCase();
        const hits = words.filter((w) => nameLower.includes(w)).length;
        const score = hits / words.length;
        if (score >= 0.5) acc.push({ app: a, score });
        return acc;
      }, [])
      .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
    if (scored.length > 0) return scored[0].app;
  }

  return null;
}

export function registryPathToRelativePath(path: string): string | null {
  if (path.startsWith("~/")) {
    return path.slice(2);
  }
  const homePrefix = "/home/matrixos/home/";
  if (path.startsWith(homePrefix)) {
    return path.slice(homePrefix.length);
  }
  return null;
}
