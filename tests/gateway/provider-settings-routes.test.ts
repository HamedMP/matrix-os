import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderSettingsMutationResponseSchema,
  type ProviderSettingsMutation,
  type ProviderSettingsMutationResponse,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { ProviderSettingsStoreError } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";

const snapshot: ProviderSettingsSnapshot = {
  contractVersion: 1,
  projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 12 },
  revision: 0,
  refreshedAt: "2026-08-30T10:00:00.000Z",
  access: { mode: "writable" },
  supportedActions: [
    "add_harness",
    "update_harness",
    "set_harness_enabled",
    "set_route",
    "select_account",
    "select_access_source",
    "set_gateway_budget",
    "set_gateway_allowlist",
  ],
  harnessCatalog: [
    { harness: "hermes", displayName: "Hermes", installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null },
    { harness: "openclaw", displayName: "OpenClaw", installState: "missing", available: true, runnable: false, setupAction: "install", safeReason: "not_installed" },
    { harness: "pi", displayName: "Pi", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" },
    { harness: "opencode", displayName: "OpenCode", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" },
  ],
  modelProviders: [{
    id: "anthropic",
    displayName: "Anthropic",
    models: [{ id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true }],
  }],
  accessSources: [{
    id: "source_matrix",
    kind: "matrix_gateway",
    fundingKind: "matrix_included",
    providerId: "anthropic",
    accountId: null,
    displayName: "Matrix AI",
    readiness: {
      state: "ready",
      checkedAt: "2026-08-30T10:00:00.000Z",
      staleAfter: "2026-08-30T10:05:00.000Z",
      action: "none",
      safeReason: null,
    },
    eligibleModelIds: ["anthropic/claude-opus-5"],
    usage: {
      kind: "managed_credit",
      authority: "matrix_ledger",
      state: "current",
      scope: "owner_entitlement",
      currency: "USD",
      usedMicrousd: 0,
      remainingMicrousd: 0,
      limitMicrousd: 0,
      periodStartedAt: "2026-08-30T10:00:00.000Z",
      resetsAt: null,
      asOf: "2026-08-30T10:00:00.000Z",
      credit: {
        promotionalBalanceMicrousd: 0,
        addonBalanceMicrousd: 0,
        creditBalanceMicrousd: 0,
        reservedMicrousd: 0,
        remainingBalanceMicrousd: 0,
      },
      budget: {
        monthlyBudgetMicrousd: 0,
        settledThisMonthMicrousd: 0,
        reservedThisMonthMicrousd: 0,
        remainingBudgetMicrousd: 0,
      },
    },
  }],
  accounts: [],
  harnesses: [],
  gatewayPolicy: {
    accessSourceId: "source_matrix",
    monthlyBudgetMicrousd: 10_000_000,
    allowedModelIds: ["anthropic/claude-opus-5"],
    topUpEnabled: false,
  },
};

function createApp(options: {
  getSnapshot?: () => Promise<ProviderSettingsSnapshot>;
  mutate?: (input: ProviderSettingsMutation) => Promise<ProviderSettingsMutationResponse>;
  getPrincipal?: () => unknown;
} = {}) {
  const getSnapshot = vi.fn(options.getSnapshot ?? (async () => snapshot));
  const mutate = vi.fn(options.mutate ?? (async () => ({
    kind: "snapshot" as const,
    snapshot: { ...snapshot, revision: 1 },
  })));
  const getPrincipal = vi.fn(options.getPrincipal ?? (() => ({ userId: "owner_123" })));
  const app = new Hono();
  app.route("/api/ai", createProviderSettingsRoutes({
    store: { getSnapshot, mutate },
    getPrincipal,
  }));
  return { app, getSnapshot, mutate, getPrincipal };
}

describe("provider settings routes", () => {
  it("authenticates reads and returns the secret-free snapshot", async () => {
    const { app, getPrincipal, getSnapshot } = createApp();
    const response = await app.request("/api/ai/provider-settings");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(getPrincipal).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it("validates each revisioned action before mutation", async () => {
    const { app, mutate } = createApp();
    const invalid = await app.request("/api/ai/provider-settings/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "set_gateway_budget", monthlyBudgetMicrousd: 20_000_000 }),
    });
    expect(invalid.status).toBe(400);
    expect(mutate).not.toHaveBeenCalled();

    const valid = await app.request("/api/ai/provider-settings/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "set_gateway_budget",
        expectedRevision: 0,
        idempotencyKey: "budget_1",
        monthlyBudgetMicrousd: 20_000_000,
      }),
    });
    expect(valid.status).toBe(200);
    expect(ProviderSettingsMutationResponseSchema.safeParse(await valid.json()).success).toBe(true);
    expect(mutate).toHaveBeenCalledWith({
      type: "set_gateway_budget",
      expectedRevision: 0,
      idempotencyKey: "budget_1",
      monthlyBudgetMicrousd: 20_000_000,
    });
  });

  it("rejects unauthenticated reads and mutations before touching the store", async () => {
    const { app, getSnapshot, mutate } = createApp({
      getPrincipal: () => { throw new Error("private authentication detail"); },
    });
    expect((await app.request("/api/ai/provider-settings")).status).toBe(401);
    expect((await app.request("/api/ai/provider-settings/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "set_gateway_budget",
        expectedRevision: 0,
        idempotencyKey: "budget_1",
        monthlyBudgetMicrousd: 20_000_000,
      }),
    })).status).toBe(401);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("applies body limits to POST and DELETE mutations", async () => {
    const { app, mutate } = createApp();
    const oversizedBody = JSON.stringify({
      type: "set_gateway_allowlist",
      expectedRevision: 0,
      idempotencyKey: "allowlist_large_1",
      allowedModelIds: Array.from({ length: 5_000 }, (_, index) => `model_${index}_${"x".repeat(20)}`),
    });
    const post = await app.request("/api/ai/provider-settings/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(oversizedBody.length) },
      body: oversizedBody,
    });
    expect(post.status).toBe(413);

    const deleteBody = JSON.stringify({
      expectedRevision: 0,
      idempotencyKey: "remove_large_1",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      confirmation: "remove_account",
      padding: "x".repeat(70_000),
    });
    const remove = await app.request("/api/ai/provider-settings/accounts/account_personal", {
      method: "DELETE",
      headers: { "content-type": "application/json", "content-length": String(deleteBody.length) },
      body: deleteBody,
    });
    expect(remove.status).toBe(413);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("supports a bounded DELETE account route without conflating logout", async () => {
    const { app, mutate } = createApp();
    const response = await app.request("/api/ai/provider-settings/accounts/account_personal", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 4,
        idempotencyKey: "remove_personal_1",
        dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
        confirmation: "remove_account",
      }),
    });
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith({
      type: "remove_account",
      expectedRevision: 4,
      idempotencyKey: "remove_personal_1",
      accountId: "account_personal",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      confirmation: "remove_account",
    });
  });

  it("maps typed conflicts and internal failures to provider-neutral errors", async () => {
    const conflict = createApp({
      mutate: async () => {
        throw new ProviderSettingsStoreError("revision_conflict", 409, { latestRevision: 7 });
      },
    });
    const conflictResponse = await conflict.app.request("/api/ai/provider-settings/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "set_gateway_budget",
        expectedRevision: 0,
        idempotencyKey: "budget_conflict_1",
        monthlyBudgetMicrousd: 20_000_000,
      }),
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: { code: "revision_conflict", message: "Provider settings changed. Refresh and try again." },
      latestRevision: 7,
    });

    const failure = createApp({
      getSnapshot: async () => { throw new Error("Anthropic sk-secret at /opt/private"); },
    });
    const failedResponse = await failure.app.request("/api/ai/provider-settings");
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.json()).toEqual({
      error: { code: "provider_settings_unavailable", message: "Provider settings are unavailable." },
    });
  });
});
