import {
  ProviderIdSchema,
  ProviderUsageResponseSchema,
  ProviderUsageSourceSummarySchema,
  RuntimeIdSchema,
  type AgentProviderSummary,
  type ProviderUsageResponse,
  type ProviderUsageSourceSummary,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import { createRateLimiter, type RateLimiter } from "../security/rate-limiter.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import type { CodingAgentProviderAdapter } from "./provider-adapter.js";
import type { CodingAgentProviderRegistry } from "./provider-registry.js";

const DEFAULT_PROVIDER_TIMEOUT_MS = 3_000;
const MAX_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_MAX_AGE_MS = 15 * 60_000;
const MAX_STALE_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_ENTRIES = 2_048;
const MAX_USAGE_SOURCES = 20;
const MAX_SOURCES_PER_PROVIDER = 6;

const ProviderUsageSourceListSchema = z.array(ProviderUsageSourceSummarySchema)
  .max(MAX_SOURCES_PER_PROVIDER);
const ProviderUsageSnapshotListSchema = z.array(ProviderUsageSourceSummarySchema)
  .max(MAX_USAGE_SOURCES);

interface ProviderUsageCacheEntry {
  expiresAt: number;
  response: ProviderUsageResponse;
}

export interface ProviderUsageSnapshotStore {
  upsert(input: {
    ownerId: string;
    runtimeId: string;
    source: ProviderUsageSourceSummary;
  }): Promise<void>;
  list(input: {
    ownerId: string;
    runtimeId: string;
  }): Promise<ProviderUsageSourceSummary[]>;
}

export interface CodingAgentProviderUsageService {
  getUsage(
    principal: RequestPrincipal,
    options?: { forceRefresh?: boolean },
  ): Promise<ProviderUsageResponse>;
  close(): void;
}

export interface CodingAgentProviderUsageServiceOptions {
  providers: readonly CodingAgentUsageProviderAdapter[];
  providerRegistry: Pick<CodingAgentProviderRegistry, "listProviders">;
  snapshotRepository?: ProviderUsageSnapshotStore;
  runtimeId: string;
  now?: () => Date;
  providerTimeoutMs?: number;
  cacheTtlMs?: number;
  staleMaxAgeMs?: number;
  maxCacheEntries?: number;
  forceRefreshRateLimiter?: Pick<RateLimiter, "check">;
}

export type CodingAgentUsageProviderAdapter = Pick<
  CodingAgentProviderAdapter,
  "providerId" | "getUsageSources"
>;

const BUILTIN_PROVIDER_METADATA: Partial<Record<
  string,
  Pick<AgentProviderSummary, "displayName" | "kind">
>> = {
  claude: { displayName: "Claude", kind: "claude" },
  codex: { displayName: "Codex", kind: "codex" },
  opencode: { displayName: "OpenCode", kind: "opencode" },
  pi: { displayName: "Pi", kind: "pi" },
};

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function fallbackSummary(providerId: string): AgentProviderSummary {
  const metadata = BUILTIN_PROVIDER_METADATA[providerId];
  return {
    id: ProviderIdSchema.parse(providerId),
    displayName: metadata?.displayName ?? providerId,
    kind: metadata?.kind ?? "custom",
    availability: "unknown",
    installStatus: "unknown",
    authStatus: "unknown",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
  };
}

function statusSource(
  summary: AgentProviderSummary,
  state: "setup_required" | "unavailable" | "unsupported",
): ProviderUsageSourceSummary {
  return ProviderUsageSourceSummarySchema.parse({
    id: summary.id,
    displayName: summary.displayName,
    linkedAgentProviderIds: [summary.id],
    state,
    windows: [],
    setupActions: state === "setup_required" ? summary.setupActions.slice(0, 4) : [],
  });
}

function needsSetup(summary: AgentProviderSummary): boolean {
  return summary.availability === "setup_required"
    || summary.availability === "auth_required"
    || summary.installStatus === "missing"
    || summary.authStatus === "missing"
    || summary.authStatus === "expired";
}

function withoutExpiredValues(source: ProviderUsageSourceSummary): ProviderUsageSourceSummary {
  return ProviderUsageSourceSummarySchema.parse({
    id: source.id,
    displayName: source.displayName,
    linkedAgentProviderIds: source.linkedAgentProviderIds,
    state: "unavailable",
    windows: [],
    setupActions: source.setupActions,
  });
}

function snapshotFallback(
  providerId: string,
  summary: AgentProviderSummary,
  snapshots: readonly ProviderUsageSourceSummary[],
  nowMs: number,
  staleMaxAgeMs: number,
): ProviderUsageSourceSummary[] {
  const linked = snapshots.filter((snapshot) =>
    snapshot.linkedAgentProviderIds.includes(providerId)
  );
  if (linked.length === 0) return [statusSource(summary, "unavailable")];

  return linked.map((snapshot) => {
    const observedAt = snapshot.observedAt ? Date.parse(snapshot.observedAt) : Number.NaN;
    const age = Number.isFinite(observedAt) ? Math.max(0, nowMs - observedAt) : Number.POSITIVE_INFINITY;
    return age <= staleMaxAgeMs
      ? ProviderUsageSourceSummarySchema.parse({ ...snapshot, state: "stale" })
      : withoutExpiredValues(snapshot);
  });
}

async function callWithTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Provider usage probe timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => call(signal))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizedAvailableSource(
  source: ProviderUsageSourceSummary,
  providerId: string,
  observedAt: string,
  expiresAt: string,
): ProviderUsageSourceSummary {
  const parsed = ProviderUsageSourceSummarySchema.parse({
    ...source,
    observedAt: source.observedAt ?? observedAt,
    expiresAt: source.expiresAt ?? expiresAt,
  });
  if (!parsed.linkedAgentProviderIds.includes(providerId)) {
    throw new Error("Provider usage source is not linked to its adapter");
  }
  return parsed;
}

function stableSources(sources: readonly ProviderUsageSourceSummary[]): ProviderUsageSourceSummary[] {
  const unique = new Map<string, ProviderUsageSourceSummary>();
  for (const source of sources.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!unique.has(source.id)) unique.set(source.id, source);
  }
  return [...unique.values()].slice(0, MAX_USAGE_SOURCES);
}

function staleCachedResponse(
  response: ProviderUsageResponse,
  requestedAt: Date,
  staleMaxAgeMs: number,
): ProviderUsageResponse {
  const requestedAtMs = requestedAt.getTime();
  return ProviderUsageResponseSchema.parse({
    usageSources: response.usageSources.map((source) => {
      if (source.state !== "available" && source.state !== "stale") return source;
      const observedAt = source.observedAt ? Date.parse(source.observedAt) : Number.NaN;
      const age = Number.isFinite(observedAt)
        ? Math.max(0, requestedAtMs - observedAt)
        : Number.POSITIVE_INFINITY;
      return age <= staleMaxAgeMs
        ? { ...source, state: "stale" as const }
        : withoutExpiredValues(source);
    }),
    serverTime: requestedAt.toISOString(),
  });
}

export function createCodingAgentProviderUsageService(
  options: CodingAgentProviderUsageServiceOptions,
): CodingAgentProviderUsageService {
  const runtimeId = RuntimeIdSchema.parse(options.runtimeId);
  const now = options.now ?? (() => new Date());
  const providerTimeoutMs = boundedInteger(
    options.providerTimeoutMs,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    MAX_PROVIDER_TIMEOUT_MS,
  );
  const cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
  const staleMaxAgeMs = boundedInteger(
    options.staleMaxAgeMs,
    DEFAULT_STALE_MAX_AGE_MS,
    MAX_STALE_MAX_AGE_MS,
  );
  const maxCacheEntries = boundedInteger(
    options.maxCacheEntries,
    DEFAULT_MAX_CACHE_ENTRIES,
    MAX_CACHE_ENTRIES,
  );
  const refreshLimiter = options.forceRefreshRateLimiter ?? createRateLimiter({
    maxAttempts: 3,
    windowMs: 60_000,
    lockoutMs: 60_000,
    maxKeys: maxCacheEntries,
  });
  const cache = new Map<string, ProviderUsageCacheEntry>();
  const providers = options.providers
    .slice()
    .sort((left, right) => left.providerId.localeCompare(right.providerId));

  function setCache(key: string, entry: ProviderUsageCacheEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function readSnapshots(ownerId: string): Promise<ProviderUsageSourceSummary[]> {
    if (!options.snapshotRepository) return [];
    try {
      return ProviderUsageSnapshotListSchema.parse(
        await options.snapshotRepository.list({ ownerId, runtimeId }),
      );
    } catch (err: unknown) {
      logCodingAgentWarning("provider usage snapshots unavailable", err);
      return [];
    }
  }

  async function readSummaries(principal: RequestPrincipal): Promise<Map<string, AgentProviderSummary>> {
    try {
      const summaries = await options.providerRegistry.listProviders(principal);
      return new Map(summaries.map((summary) => [summary.id, summary]));
    } catch (err: unknown) {
      logCodingAgentWarning("provider usage summaries unavailable", err);
      return new Map();
    }
  }

  async function persist(source: ProviderUsageSourceSummary, ownerId: string): Promise<void> {
    if (!options.snapshotRepository || source.state !== "available") return;
    try {
      await options.snapshotRepository.upsert({ ownerId, runtimeId, source });
    } catch (err: unknown) {
      logCodingAgentWarning("provider usage snapshot write failed", err);
    }
  }

  async function probeProvider(input: {
    adapter: CodingAgentUsageProviderAdapter;
    principal: RequestPrincipal;
    summary: AgentProviderSummary;
    snapshots: readonly ProviderUsageSourceSummary[];
    observedAt: string;
    expiresAt: string;
  }): Promise<ProviderUsageSourceSummary[]> {
    if (needsSetup(input.summary)) return [statusSource(input.summary, "setup_required")];
    if (!input.adapter.getUsageSources) return [statusSource(input.summary, "unsupported")];

    try {
      const rawSources = await callWithTimeout(providerTimeoutMs, (signal) =>
        input.adapter.getUsageSources!({ principal: input.principal, now, signal })
      );
      const sources = ProviderUsageSourceListSchema.parse(rawSources).map((source) =>
        normalizedAvailableSource(
          source,
          input.adapter.providerId,
          input.observedAt,
          input.expiresAt,
        )
      );
      if (sources.length === 0) return [statusSource(input.summary, "unsupported")];
      await Promise.all(sources.map((source) => persist(source, input.principal.userId)));
      return sources;
    } catch (err: unknown) {
      logCodingAgentWarning(`provider usage probe failed for ${input.adapter.providerId}`, err);
      return snapshotFallback(
        input.adapter.providerId,
        input.summary,
        input.snapshots,
        Date.parse(input.observedAt),
        staleMaxAgeMs,
      );
    }
  }

  return {
    async getUsage(principal, requestOptions = {}) {
      const cacheKey = `${principal.userId}:${runtimeId}`;
      const requestedAt = now();
      const requestedAtMs = requestedAt.getTime();
      const cached = cache.get(cacheKey);

      if (requestOptions.forceRefresh) {
        if (!refreshLimiter.check(cacheKey) && cached) {
          return cached.expiresAt > requestedAtMs
            ? cached.response
            : staleCachedResponse(cached.response, requestedAt, staleMaxAgeMs);
        }
      } else if (cached && cached.expiresAt > requestedAtMs) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return cached.response;
      }

      const observedAt = requestedAt.toISOString();
      const expiresAt = new Date(requestedAtMs + cacheTtlMs).toISOString();
      const [summaries, snapshots] = await Promise.all([
        readSummaries(principal),
        readSnapshots(principal.userId),
      ]);
      const groups = await Promise.all(providers.map((provider) =>
        probeProvider({
          adapter: provider,
          principal,
          summary: summaries.get(provider.providerId) ?? fallbackSummary(provider.providerId),
          snapshots,
          observedAt,
          expiresAt,
        })
      ));
      const response = ProviderUsageResponseSchema.parse({
        usageSources: stableSources(groups.flat()),
        serverTime: observedAt,
      });
      setCache(cacheKey, { response, expiresAt: requestedAtMs + cacheTtlMs });
      return response;
    },

    close() {
      cache.clear();
    },
  };
}
