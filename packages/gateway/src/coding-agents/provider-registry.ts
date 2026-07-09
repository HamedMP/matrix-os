import {
  AgentProviderSummarySchema,
  ProviderIdSchema,
  SafeSetupActionSchema,
  type AgentProviderSummary,
  type SafeSetupAction,
} from "@matrix-os/contracts";
import type {
  AgentCredentialSummary,
} from "../onboarding/activation-contracts.js";
import type { AgentCredentialStatusService } from "../onboarding/agent-credential-status.js";
import type { RequestPrincipal } from "../request-principal.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import type { CodingAgentProviderAdapter } from "./thread-store.js";

const MAX_PROVIDERS = 8;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const MAX_HEALTH_TIMEOUT_MS = 30_000;
const MAX_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 2_048;

interface HealthCacheEntry {
  checkedAt: string;
  expiresAt: number;
  ok: boolean;
}

export interface CodingAgentProviderRegistry {
  listProviders(principal: RequestPrincipal): Promise<AgentProviderSummary[]>;
  invalidate(ownerId?: string, providerId?: string): void;
}

export interface CodingAgentProviderRegistryOptions {
  providers: readonly CodingAgentProviderAdapter[];
  agentCredentials?: Pick<AgentCredentialStatusService, "getStatus">;
  now?: () => Date;
  healthTimeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

class ProviderCallTimeoutError extends Error {
  constructor() {
    super("Provider check timed out");
    this.name = "ProviderCallTimeoutError";
  }
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function fallbackSummary(providerId: string, checkedAt?: string): AgentProviderSummary {
  return AgentProviderSummarySchema.parse({
    id: providerId,
    displayName: "Coding agent",
    kind: "custom",
    availability: "unavailable",
    installStatus: "unknown",
    authStatus: "unknown",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
    lastCheckedAt: checkedAt,
  });
}

async function callWithTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderCallTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => call(signal))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function applyCredentialState(
  summary: AgentProviderSummary,
  credential: AgentCredentialSummary | undefined,
): AgentProviderSummary {
  if (!credential || credential.status === "not_applicable") return summary;
  if (credential.status === "missing") {
    return {
      ...summary,
      availability: "setup_required",
      installStatus: "missing",
      authStatus: "missing",
    };
  }
  if (credential.status === "expired" || credential.status === "revoked") {
    return {
      ...summary,
      availability: "auth_required",
      installStatus: "installed",
      authStatus: "expired",
    };
  }
  if (credential.status === "failed") {
    return {
      ...summary,
      availability: "unavailable",
      installStatus: "failed",
      authStatus: "unknown",
    };
  }
  return {
    ...summary,
    installStatus: "installed",
    authStatus: "authenticated",
  };
}

function shouldCheckHealth(summary: AgentProviderSummary): boolean {
  return summary.availability === "available" &&
    summary.installStatus === "installed" &&
    summary.authStatus === "authenticated";
}

export function createCodingAgentProviderRegistry(
  options: CodingAgentProviderRegistryOptions,
): CodingAgentProviderRegistry {
  if (options.providers.length > MAX_PROVIDERS) {
    throw new Error(`Coding-agent provider registry supports at most ${MAX_PROVIDERS} providers`);
  }
  const providers = options.providers.map((provider) => {
    ProviderIdSchema.parse(provider.providerId);
    return provider;
  });
  for (let index = 0; index < providers.length; index += 1) {
    if (providers.slice(0, index).some((provider) => provider.providerId === providers[index]!.providerId)) {
      throw new Error(`Duplicate coding-agent provider: ${providers[index]!.providerId}`);
    }
  }

  const now = options.now ?? (() => new Date());
  const healthTimeoutMs = boundedInteger(
    options.healthTimeoutMs,
    DEFAULT_HEALTH_TIMEOUT_MS,
    MAX_HEALTH_TIMEOUT_MS,
  );
  const cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
  const maxCacheEntries = boundedInteger(
    options.maxCacheEntries,
    DEFAULT_MAX_CACHE_ENTRIES,
    MAX_CACHE_ENTRIES,
  );
  const healthCache = new Map<string, HealthCacheEntry>();

  function cacheKey(ownerId: string, providerId: string): string {
    return `${ownerId}:${providerId}`;
  }

  function cachedHealth(key: string, timestamp: number): HealthCacheEntry | undefined {
    const entry = healthCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= timestamp) {
      healthCache.delete(key);
      return undefined;
    }
    healthCache.delete(key);
    healthCache.set(key, entry);
    return entry;
  }

  function storeHealth(key: string, entry: HealthCacheEntry): void {
    healthCache.delete(key);
    while (healthCache.size >= maxCacheEntries) {
      const oldest = healthCache.keys().next().value as string | undefined;
      if (!oldest) break;
      healthCache.delete(oldest);
    }
    healthCache.set(key, entry);
  }

  async function readCredentials(principal: RequestPrincipal): Promise<AgentCredentialSummary[]> {
    if (!options.agentCredentials) return [];
    try {
      return (await options.agentCredentials.getStatus(principal.userId)).agents;
    } catch (err: unknown) {
      logCodingAgentWarning("provider credential summary unavailable", err);
      return [];
    }
  }

  async function readBaseSummary(
    provider: CodingAgentProviderAdapter,
    principal: RequestPrincipal,
    checkedAt: Date,
  ): Promise<{ summary: AgentProviderSummary; valid: boolean }> {
    if (!provider.getSummary) {
      return { summary: fallbackSummary(provider.providerId, checkedAt.toISOString()), valid: false };
    }
    try {
      const raw = await callWithTimeout(healthTimeoutMs, (signal) => provider.getSummary!({
        principal,
        now: () => checkedAt,
        signal,
      }));
      const summary = AgentProviderSummarySchema.parse(raw);
      if (summary.id !== provider.providerId) throw new Error("Provider summary id mismatch");
      return { summary, valid: true };
    } catch (err: unknown) {
      logCodingAgentWarning("provider summary invalid", err);
      return { summary: fallbackSummary(provider.providerId, checkedAt.toISOString()), valid: false };
    }
  }

  async function readSetupActions(
    provider: CodingAgentProviderAdapter,
    principal: RequestPrincipal,
    checkedAt: Date,
    fallback: SafeSetupAction[],
  ): Promise<SafeSetupAction[]> {
    if (!provider.buildSetupAction) return fallback;
    try {
      const actions = await callWithTimeout(healthTimeoutMs, (signal) => provider.buildSetupAction!({
        principal,
        now: () => checkedAt,
        signal,
      }));
      return SafeSetupActionSchema.array().max(6).parse(actions);
    } catch (err: unknown) {
      logCodingAgentWarning("provider setup actions unavailable", err);
      return fallback;
    }
  }

  async function readHealth(
    provider: CodingAgentProviderAdapter,
    principal: RequestPrincipal,
    checkedAt: Date,
  ): Promise<HealthCacheEntry> {
    const key = cacheKey(principal.userId, provider.providerId);
    const cached = cachedHealth(key, checkedAt.getTime());
    if (cached) return cached;

    let ok = false;
    try {
      const result = provider.healthCheck
        ? await callWithTimeout(healthTimeoutMs, (signal) => provider.healthCheck!({
          principal,
          now: () => checkedAt,
          signal,
        }))
        : { ok: true };
      ok = result != null && typeof result === "object" && result.ok === true;
    } catch (err: unknown) {
      logCodingAgentWarning("provider health unavailable", err);
    }

    const entry = {
      ok,
      checkedAt: checkedAt.toISOString(),
      expiresAt: checkedAt.getTime() + cacheTtlMs,
    };
    storeHealth(key, entry);
    return entry;
  }

  async function summaryForProvider(
    provider: CodingAgentProviderAdapter,
    principal: RequestPrincipal,
    credentials: AgentCredentialSummary[],
  ): Promise<AgentProviderSummary> {
    const checkedAt = now();
    const base = await readBaseSummary(provider, principal, checkedAt);
    if (!base.valid) return base.summary;

    const setupActions = await readSetupActions(
      provider,
      principal,
      checkedAt,
      base.summary.setupActions,
    );
    const credential = credentials.find((candidate) => candidate.agent === provider.providerId);
    const normalized = applyCredentialState({ ...base.summary, setupActions }, credential);
    if (!shouldCheckHealth(normalized)) return AgentProviderSummarySchema.parse(normalized);

    const health = await readHealth(provider, principal, checkedAt);
    return AgentProviderSummarySchema.parse({
      ...normalized,
      availability: health.ok ? normalized.availability : "unavailable",
      lastCheckedAt: health.checkedAt,
    });
  }

  return {
    async listProviders(principal) {
      const credentials = await readCredentials(principal);
      const summaries = await Promise.all(
        providers.map((provider) => summaryForProvider(provider, principal, credentials)),
      );
      return summaries.sort((left, right) => left.id.localeCompare(right.id));
    },
    invalidate(ownerId, providerId) {
      for (const key of healthCache.keys()) {
        const matchesOwner = !ownerId || key.startsWith(`${ownerId}:`);
        const matchesProvider = !providerId || key.endsWith(`:${providerId}`);
        if (matchesOwner && matchesProvider) healthCache.delete(key);
      }
    },
  };
}
