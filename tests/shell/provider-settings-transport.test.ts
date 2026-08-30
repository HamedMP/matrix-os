// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";

vi.mock("@matrix-os/ui", () => ({
  ProviderSettingsTransportError: class ProviderSettingsTransportError extends Error {
    constructor(readonly code: string) {
      super("Provider settings are unavailable.");
      this.name = "ProviderSettingsTransportError";
    }
  },
}));

import {
  createProviderSettingsTransport,
  ProviderSettingsTransportError,
} from "../../shell/src/lib/provider-settings-transport.js";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup.js";

const snapshot = ProviderSettingsSnapshotSchema.parse({
  contractVersion: 1,
  projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 4 },
  revision: 2,
  refreshedAt: "2026-08-30T10:00:00.000Z",
  access: { mode: "read_only", reason: "runtime_unavailable" },
  supportedActions: [],
  modelProviders: [{
    id: "anthropic",
    displayName: "Anthropic",
    models: [{ id: "claude-opus-5", displayName: "Claude Opus 5", enabled: true }],
  }],
  accessSources: [{
    id: "matrix_included",
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
    eligibleModelIds: ["claude-opus-5"],
    usage: {
      kind: "unavailable",
      authority: "unavailable",
      state: "unavailable",
      scope: "owner_entitlement",
      reason: "ledger_not_available",
      asOf: null,
    },
  }],
  accounts: [],
  harnesses: [{
    id: "harness_kernel",
    harness: "claude",
    displayName: "Claude",
    accentColor: null,
    enabled: true,
    version: null,
    installState: "installed",
    authState: "authenticated",
    loginMethods: ["terminal"],
    recommendedLoginMethod: "terminal",
    connectivity: "online",
    accountIds: [],
    selectedAccountId: null,
    accessSourceId: "matrix_included",
    route: { kind: "fixed", providerId: "anthropic", modelId: "claude-opus-5" },
    activeChatCount: 0,
  }],
  gatewayPolicy: {
    accessSourceId: "matrix_included",
    monthlyBudgetMicrousd: null,
    allowedModelIds: ["claude-opus-5"],
    topUpEnabled: false,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider settings shell transport", () => {
  it("loads and schema-validates a bounded no-store snapshot from the active gateway", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot));
    const transport = createProviderSettingsTransport({ fetcher });

    await expect(transport.getSnapshot()).resolves.toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith(
      `${window.location.origin}/api/ai/provider-settings`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("invalidates the shared Provider catalog only after a successful mutation", async () => {
    const changed = vi.fn();
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
    const fetcher = vi.fn(async () => Response.json({ kind: "snapshot", snapshot }));
    const transport = createProviderSettingsTransport({ fetcher });

    await expect(transport.mutate({
      type: "set_gateway_budget",
      expectedRevision: 2,
      idempotencyKey: "budget_success",
      monthlyBudgetMicrousd: 2_000_000,
    })).resolves.toEqual({ kind: "snapshot", snapshot });
    expect(changed).toHaveBeenCalledOnce();

    window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
  });

  it("validates mutation inputs and responses without exposing upstream details", async () => {
    const fetcher = vi.fn(async () => new Response("Anthropic sk-secret at /opt/private", { status: 503 }));
    const transport = createProviderSettingsTransport({ fetcher });
    await expect(transport.mutate({ type: "bad_action" })).rejects.toEqual(
      expect.objectContaining({ code: "invalid_request", message: "Provider settings are unavailable." }),
    );
    expect(fetcher).not.toHaveBeenCalled();

    await expect(transport.mutate({
      type: "set_gateway_budget",
      expectedRevision: 2,
      idempotencyKey: "budget_1",
      monthlyBudgetMicrousd: 2_000_000,
    })).rejects.toBeInstanceOf(ProviderSettingsTransportError);
    await expect(transport.mutate({
      type: "set_gateway_budget",
      expectedRevision: 2,
      idempotencyKey: "budget_2",
      monthlyBudgetMicrousd: 2_000_000,
    })).rejects.not.toThrow(/Anthropic|secret|private/i);
  });

  it("rejects oversized or malformed successful responses", async () => {
    const oversized = vi.fn(async () => new Response("x".repeat(1_100_000), {
      headers: { "content-length": "1100000" },
    }));
    await expect(createProviderSettingsTransport({ fetcher: oversized }).getSnapshot())
      .rejects.toEqual(expect.objectContaining({ code: "invalid_response" }));

    const malformed = vi.fn(async () => Response.json({ ...snapshot, revision: "not-a-number" }));
    await expect(createProviderSettingsTransport({ fetcher: malformed }).getSnapshot())
      .rejects.toEqual(expect.objectContaining({ code: "invalid_response" }));
  });

  it("preserves only allowlisted conflict codes from bounded error bodies", async () => {
    const conflict = vi.fn(async () => Response.json({
      error: { code: "revision_conflict", message: "Anthropic sk-secret at /opt/private" },
    }, { status: 409 }));
    const transport = createProviderSettingsTransport({ fetcher: conflict });

    await expect(transport.mutate({
      type: "set_gateway_budget",
      expectedRevision: 2,
      idempotencyKey: "budget_conflict",
      monthlyBudgetMicrousd: 2_000_000,
    })).rejects.toEqual(expect.objectContaining({
      code: "revision_conflict",
      message: "Provider settings are unavailable.",
    }));

    const unknown = vi.fn(async () => Response.json({
      error: { code: "database_failed", message: "/private/db" },
    }, { status: 500 }));
    await expect(createProviderSettingsTransport({ fetcher: unknown }).getSnapshot())
      .rejects.toEqual(expect.objectContaining({ code: "unavailable" }));
  });
});
