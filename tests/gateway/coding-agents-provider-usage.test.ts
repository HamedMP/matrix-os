import {
  ProviderUsageResponseSchema,
  type AgentProviderSummary,
  type ProviderUsageSourceSummary,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import {
  createCodingAgentProviderUsageService,
  type ProviderUsageSnapshotStore,
} from "../../packages/gateway/src/coding-agents/provider-usage.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-08-10T12:00:00.000Z");

function summary(
  id: string,
  overrides: Partial<AgentProviderSummary> = {},
): AgentProviderSummary {
  return {
    id,
    displayName: id === "codex" ? "Codex" : id === "claude" ? "Claude" : id,
    kind: id === "codex" ? "codex" : id === "claude" ? "claude" : "custom",
    availability: "available",
    installStatus: "installed",
    authStatus: "authenticated",
    supportedModes: ["default"],
    defaultMode: "default",
    setupActions: [],
    ...overrides,
  };
}

function availableSource(
  overrides: Partial<ProviderUsageSourceSummary> = {},
): ProviderUsageSourceSummary {
  return {
    id: "openai-chatgpt",
    displayName: "OpenAI / ChatGPT",
    linkedAgentProviderIds: ["codex"],
    state: "available",
    accuracy: "provider_reported",
    windows: [{
      id: "primary",
      label: "5-hour window",
      remainingPercent: 73,
      resetsAt: "2026-08-10T16:00:00.000Z",
      windowMinutes: 300,
    }],
    observedAt: now.toISOString(),
    expiresAt: "2026-08-10T12:05:00.000Z",
    setupActions: [],
    ...overrides,
  };
}

function adapter(
  providerId: string,
  getUsageSources?: CodingAgentProviderAdapter["getUsageSources"],
): CodingAgentProviderAdapter {
  return {
    providerId,
    ...(getUsageSources ? { getUsageSources } : {}),
    startThread: async () => [],
  };
}

class MemorySnapshotStore implements ProviderUsageSnapshotStore {
  readonly values = new Map<string, ProviderUsageSourceSummary[]>();

  async upsert(input: {
    ownerId: string;
    runtimeId: string;
    source: ProviderUsageSourceSummary;
  }): Promise<void> {
    const key = `${input.ownerId}:${input.runtimeId}`;
    const existing = this.values.get(key) ?? [];
    this.values.set(key, [
      ...existing.filter((source) => source.id !== input.source.id),
      input.source,
    ]);
  }

  async list(input: { ownerId: string; runtimeId: string }): Promise<ProviderUsageSourceSummary[]> {
    return this.values.get(`${input.ownerId}:${input.runtimeId}`) ?? [];
  }
}

function createService(input: {
  providers: CodingAgentProviderAdapter[];
  summaries: AgentProviderSummary[];
  snapshots?: ProviderUsageSnapshotStore;
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefreshRateLimiter?: { check(key: string): boolean };
}) {
  return createCodingAgentProviderUsageService({
    providers: input.providers,
    providerRegistry: { listProviders: async () => input.summaries },
    snapshotRepository: input.snapshots,
    runtimeId: "rt_primary",
    now: input.now ?? (() => now),
    cacheTtlMs: input.cacheTtlMs,
    providerTimeoutMs: 100,
    forceRefreshRateLimiter: input.forceRefreshRateLimiter,
  });
}

describe("coding agent provider usage", () => {
  it("normalizes exact sources and persists only available provider data", async () => {
    const snapshots = new MemorySnapshotStore();
    const getUsageSources = vi.fn(async () => [availableSource()]);
    const service = createService({
      providers: [adapter("codex", getUsageSources)],
      summaries: [summary("codex")],
      snapshots,
    });

    const response = ProviderUsageResponseSchema.parse(await service.getUsage(testPrincipal));

    expect(response.usageSources).toEqual([availableSource()]);
    expect(getUsageSources).toHaveBeenCalledWith(expect.objectContaining({
      principal: testPrincipal,
      now: expect.any(Function),
      signal: expect.any(AbortSignal),
    }));
    expect(await snapshots.list({ ownerId: testPrincipal.userId, runtimeId: "rt_primary" }))
      .toEqual([availableSource()]);
  });

  it("reports unsupported and setup-required runners without inventing quota", async () => {
    const service = createService({
      providers: [adapter("pi"), adapter("claude")],
      summaries: [
        summary("pi"),
        summary("claude", {
          availability: "auth_required",
          authStatus: "expired",
          setupActions: [{ id: "claude-settings", kind: "open_settings", label: "Open settings" }],
        }),
      ],
    });

    const response = await service.getUsage(testPrincipal);

    expect(response.usageSources).toEqual([
      expect.objectContaining({
        id: "claude",
        linkedAgentProviderIds: ["claude"],
        state: "setup_required",
        windows: [],
        setupActions: [{ id: "claude-settings", kind: "open_settings", label: "Open settings" }],
      }),
      expect.objectContaining({
        id: "pi",
        linkedAgentProviderIds: ["pi"],
        state: "unsupported",
        windows: [],
      }),
    ]);
    expect(JSON.stringify(response)).not.toMatch(/remainingPercent|accuracy|observedAt|expiresAt/);
  });

  it("keeps successful providers when another probe fails", async () => {
    const service = createService({
      providers: [
        adapter("codex", async () => [availableSource()]),
        adapter("claude", async () => {
          throw new Error("provider credential leaked from /home/private");
        }),
      ],
      summaries: [summary("codex"), summary("claude")],
    });

    const response = await service.getUsage(testPrincipal);

    expect(response.usageSources).toEqual([
      expect.objectContaining({ id: "claude", state: "unavailable", windows: [] }),
      availableSource(),
    ]);
    expect(JSON.stringify(response)).not.toMatch(/credential|\/home\/private/);
  });

  it("uses recent last-good data as stale after a probe failure", async () => {
    const snapshots = new MemorySnapshotStore();
    await snapshots.upsert({
      ownerId: testPrincipal.userId,
      runtimeId: "rt_primary",
      source: availableSource({
        observedAt: "2026-08-10T11:50:00.000Z",
        expiresAt: "2026-08-10T11:55:00.000Z",
      }),
    });
    const service = createService({
      providers: [adapter("codex", async () => { throw new Error("offline"); })],
      summaries: [summary("codex")],
      snapshots,
    });

    const response = await service.getUsage(testPrincipal);

    expect(response.usageSources).toEqual([
      availableSource({
        state: "stale",
        observedAt: "2026-08-10T11:50:00.000Z",
        expiresAt: "2026-08-10T11:55:00.000Z",
      }),
    ]);
  });

  it("strips quota values when the last-good snapshot is older than 15 minutes", async () => {
    const snapshots = new MemorySnapshotStore();
    await snapshots.upsert({
      ownerId: testPrincipal.userId,
      runtimeId: "rt_primary",
      source: availableSource({ observedAt: "2026-08-10T11:44:59.000Z" }),
    });
    const service = createService({
      providers: [adapter("codex", async () => { throw new Error("offline"); })],
      summaries: [summary("codex")],
      snapshots,
    });

    const [source] = (await service.getUsage(testPrincipal)).usageSources;

    expect(source).toEqual({
      id: "openai-chatgpt",
      displayName: "OpenAI / ChatGPT",
      linkedAgentProviderIds: ["codex"],
      state: "unavailable",
      windows: [],
      setupActions: [],
    });
  });

  it("caps provider sources at 20 with deterministic source ordering", async () => {
    const providers = Array.from({ length: 24 }, (_, index) => {
      const providerId = `provider-${String(index).padStart(2, "0")}`;
      return adapter(providerId, async () => [availableSource({
        id: `source-${String(23 - index).padStart(2, "0")}`,
        displayName: `Source ${23 - index}`,
        linkedAgentProviderIds: [providerId],
      })]);
    });
    const service = createService({
      providers,
      summaries: providers.map((provider) => summary(provider.providerId)),
    });

    const response = await service.getUsage(testPrincipal);

    expect(response.usageSources).toHaveLength(20);
    expect(response.usageSources.map((source) => source.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `source-${String(index).padStart(2, "0")}`),
    );
  });

  it("rate-limits forced refresh and clears cached entries on close", async () => {
    const getUsageSources = vi.fn(async () => [availableSource()]);
    const check = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const service = createService({
      providers: [adapter("codex", getUsageSources)],
      summaries: [summary("codex")],
      forceRefreshRateLimiter: { check },
    });
    await service.getUsage(testPrincipal);

    await service.getUsage(testPrincipal, { forceRefresh: true });
    expect(getUsageSources).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(`${testPrincipal.userId}:rt_primary`);

    service.close();
    await service.getUsage(testPrincipal);
    expect(getUsageSources).toHaveBeenCalledTimes(2);
  });

  it("downgrades expired cached quota when a forced refresh is rate-limited", async () => {
    let current = now;
    const getUsageSources = vi.fn(async () => [availableSource()]);
    const service = createService({
      providers: [adapter("codex", getUsageSources)],
      summaries: [summary("codex")],
      now: () => current,
      cacheTtlMs: 100,
      forceRefreshRateLimiter: { check: () => false },
    });
    await service.getUsage(testPrincipal);
    current = new Date(now.getTime() + 200);

    const response = await service.getUsage(testPrincipal, { forceRefresh: true });

    expect(getUsageSources).toHaveBeenCalledTimes(1);
    expect(response.serverTime).toBe(current.toISOString());
    expect(response.usageSources[0]?.state).toBe("stale");
  });

  it("serves strict authenticated usage and validates refresh query values", async () => {
    const usage = createService({
      providers: [adapter("codex", async () => [availableSource()])],
      summaries: [summary("codex")],
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      usage,
      getPrincipal: () => testPrincipal,
    }));

    const valid = await app.request("/api/coding-agents/usage?refresh=1");
    const invalid = await app.request("/api/coding-agents/usage?refresh=true");
    const duplicate = await app.request("/api/coding-agents/usage?refresh=1&refresh=1");

    expect(valid.status).toBe(200);
    expect(ProviderUsageResponseSchema.parse(await valid.json()).usageSources).toHaveLength(1);
    expect(invalid.status).toBe(400);
    expect(duplicate.status).toBe(400);
  });

  it("requires a principal and maps internal failures to one generic error", async () => {
    const unauthenticated = createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      usage: { getUsage: vi.fn() },
      getPrincipal: () => { throw new MissingRequestPrincipalError(); },
    });
    const failing = createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      usage: {
        getUsage: async () => {
          throw new Error("provider token at /home/private failed");
        },
      },
      getPrincipal: () => testPrincipal,
    });

    const unauthorized = await unauthenticated.request("/usage");
    const unavailable = await failing.request("/usage");

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Unauthorized" });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "usage_unavailable",
        safeMessage: "Provider usage is temporarily unavailable. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });
});
