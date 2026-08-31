import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import {
  createCodingHarnessCredentialResolver,
} from "../../packages/gateway/src/coding-agents/harness-credentials.js";

function snapshot(
  harness: "pi" | "opencode",
  accessSourceId: "matrix_included" | "owner_anthropic_key" | "owner_anthropic_profile",
): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: "providers_test" },
    revision: 1,
    refreshedAt: "2026-08-31T00:00:00.000Z",
    access: { mode: "writable" },
    supportedActions: [],
    modelProviders: [],
    accessSources: [],
    accounts: [],
    harnesses: [{
      id: `harness_${harness}`,
      harness,
      displayName: harness === "pi" ? "Pi" : "OpenCode",
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
      accessSourceId,
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
      activeChatCount: 0,
    }],
    gatewayPolicy: null,
  };
}

describe("coding harness credential resolution", () => {
  it("resolves the unique enabled harness through its exact access source", async () => {
    const resolveCredentialLaunch = vi.fn(async (_home: string, _env: NodeJS.ProcessEnv, source: string) => ({
      env: {
        ANTHROPIC_API_KEY: source === "matrix_included" ? "lease-token" : "wrong",
        ANTHROPIC_BASE_URL: "https://relay.example.test",
        UPGRADE_TOKEN: "must-not-reach-adapter",
      },
      fundedRunTimeoutMs: 120_000,
    }));
    const resolver = createCodingHarnessCredentialResolver({
      harness: "pi",
      homePath: "/home/matrix/home",
      settings: { getSnapshot: async () => snapshot("pi", "matrix_included") },
      resolveCredentialLaunch,
      baseEnv: { UPGRADE_TOKEN: "platform-secret" },
    });

    await expect(resolver()).resolves.toEqual({
      env: {
        ANTHROPIC_API_KEY: "lease-token",
        ANTHROPIC_BASE_URL: "https://relay.example.test",
      },
      maxRunMs: 120_000,
    });
    expect(resolveCredentialLaunch).toHaveBeenCalledWith(
      "/home/matrix/home",
      { UPGRADE_TOKEN: "platform-secret" },
      "matrix_included",
      undefined,
    );
  });

  it("fails closed for duplicate profiles, mismatched vendors, and non-portable Claude login", async () => {
    const base = snapshot("opencode", "owner_anthropic_key");
    const duplicate = { ...base, harnesses: [...base.harnesses, { ...base.harnesses[0]!, id: "harness_other" }] };
    const mismatched = snapshot("opencode", "owner_anthropic_key");
    mismatched.harnesses[0]!.route = { kind: "configurable", providerId: "openai", modelId: "gpt-5" };
    const profile = snapshot("opencode", "owner_anthropic_profile");

    for (const value of [duplicate, mismatched, profile]) {
      const resolver = createCodingHarnessCredentialResolver({
        harness: "opencode",
        homePath: "/home/matrix/home",
        settings: { getSnapshot: async () => value },
        resolveCredentialLaunch: vi.fn(),
      });
      await expect(resolver()).rejects.toThrow("Selected coding harness access is unavailable");
    }
  });

  it("does not return unrelated process credentials", async () => {
    const resolver = createCodingHarnessCredentialResolver({
      harness: "pi",
      homePath: "/home/matrix/home",
      settings: { getSnapshot: async () => snapshot("pi", "owner_anthropic_key") },
      resolveCredentialLaunch: async () => ({
        env: {
          ANTHROPIC_API_KEY: "owner-key",
          DATABASE_URL: "postgres://private",
          MATRIX_FUNDED_AI_RUNTIME_TOKEN: "private",
        },
      }),
    });

    expect(await resolver()).toEqual({ env: { ANTHROPIC_API_KEY: "owner-key" } });
  });
});
