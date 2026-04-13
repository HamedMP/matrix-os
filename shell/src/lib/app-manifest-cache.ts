interface ManifestEnvelope {
  manifest: {
    slug: string;
    runtime: string;
    [key: string]: unknown;
  };
  runtimeState: {
    status: string;
    [key: string]: unknown;
  };
  distributionStatus: "installable" | "gated" | "blocked";
}

interface CacheEntry {
  envelope: ManifestEnvelope;
  expiresAt: number;
}

const READY_TTL_MS = 60_000; // 60s for ready envelopes
const NON_READY_TTL_MS = 2_000; // 2s for non-ready so UI recovers quickly
const MAX_SIZE = 32;

const cache = new Map<string, CacheEntry>();

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.expiresAt < oldestTime) {
      oldestTime = entry.expiresAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    cache.delete(oldestKey);
  }
}

export async function fetchAppManifest(
  slug: string,
  gatewayUrl?: string,
): Promise<ManifestEnvelope> {
  const now = Date.now();
  const cached = cache.get(slug);
  if (cached && now < cached.expiresAt) {
    return cached.envelope;
  }

  const base = gatewayUrl ?? "";
  const res = await fetch(`${base}/api/apps/${slug}/manifest`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch manifest for ${slug}: ${res.status}`);
  }

  const envelope = (await res.json()) as ManifestEnvelope;

  // Determine TTL based on readiness
  const ttl = envelope.runtimeState.status === "ready" ? READY_TTL_MS : NON_READY_TTL_MS;

  // Evict LRU if at cap
  while (cache.size >= MAX_SIZE) {
    evictOldest();
  }

  cache.set(slug, { envelope, expiresAt: now + ttl });

  return envelope;
}

export function invalidateManifest(slug: string): void {
  cache.delete(slug);
}

export function clearManifestCache(): void {
  cache.clear();
}
