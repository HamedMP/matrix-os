/** 2694: resolves a published app for visitors without rescanning the apps directory per request. */
import type { SitePublicAppRecord } from "./public-data-repository.js";

const MISS_TTL_MS = 30_000;
const MAX_MISSES = 500;

export interface SitePublicAppResolver {
  (appSlug: string): Promise<SitePublicAppRecord | null>;
  readonly size: number;
}

/**
 * Remembers slugs with no registry record for a short window so visitor traffic does not
 * scan the apps directory on every request. The registry is still read each time, so an app
 * the owner provisions meanwhile is served at once; a newly built one is found after the window.
 */
export function createSitePublicAppResolver(options: {
  ensureProvisioned(appSlug: string): Promise<void>;
  getRecord(appSlug: string): Promise<SitePublicAppRecord | null>;
  missTtlMs?: number;
  maxMisses?: number;
  now?: () => number;
}): SitePublicAppResolver {
  const ttl = options.missTtlMs ?? MISS_TTL_MS;
  const cap = options.maxMisses ?? MAX_MISSES;
  const now = options.now ?? Date.now;
  const misses = new Map<string, number>();
  const resolve = async (appSlug: string) => {
    const expiresAt = misses.get(appSlug);
    const scan = expiresAt === undefined || expiresAt <= now();
    if (scan) await options.ensureProvisioned(appSlug);
    const record = await options.getRecord(appSlug);
    if (record) misses.delete(appSlug);
    else if (scan) {
      misses.delete(appSlug);
      misses.set(appSlug, now() + ttl);
      while (misses.size > cap) misses.delete(misses.keys().next().value!);
    }
    return record;
  };
  return Object.defineProperty(resolve, "size", { get: () => misses.size }) as SitePublicAppResolver;
}
