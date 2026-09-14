import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSettingsMutation } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import {
  PROVIDER_SETTINGS_NOW,
  providerSettingsCanonicalFixture,
} from "./provider-settings-test-support.js";

describe("provider settings fail-closed capabilities", () => {
  let homePath: string | undefined;

  afterEach(async () => {
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  it("advertises no actions and rejects every mutation with default server dependencies", async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-settings-capabilities-"));
    const canonical = providerSettingsCanonicalFixture();
    const store = new ProviderSettingsStore({
      homePath,
      providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
      now: () => PROVIDER_SETTINGS_NOW,
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.access).toEqual({ mode: "read_only", reason: "runtime_unavailable" });
    expect(snapshot.supportedActions).toEqual([]);

    const base = { expectedRevision: 0 } as const;
    const mutations: ProviderSettingsMutation[] = [
      {
        ...base,
        type: "add_harness",
        idempotencyKey: "unsupported_01",
        harness: "opencode",
        displayName: "OpenCode",
        route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
        accessSourceId: "matrix_included",
        accountId: null,
      },
      {
        ...base,
        type: "remove_harness",
        idempotencyKey: "unsupported_01b",
        harnessInstanceId: "harness_kernel",
        confirmation: "remove_harness",
      },
      { ...base, type: "update_harness", idempotencyKey: "unsupported_02", harnessInstanceId: "harness_kernel", displayName: "Claude" },
      { ...base, type: "set_harness_enabled", idempotencyKey: "unsupported_03", harnessInstanceId: "harness_kernel", enabled: false },
      { ...base, type: "set_route", idempotencyKey: "unsupported_04", harnessInstanceId: "harness_kernel", route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" }, accessSourceId: "matrix_included", accountId: null },
      { ...base, type: "select_account", idempotencyKey: "unsupported_05", harnessInstanceId: "harness_kernel", accountId: "owner_anthropic" },
      { ...base, type: "select_access_source", idempotencyKey: "unsupported_06", harnessInstanceId: "harness_kernel", accessSourceId: "matrix_included" },
      { ...base, type: "start_login", idempotencyKey: "unsupported_07", harnessInstanceId: "harness_kernel", accountId: null, method: "terminal" },
      { ...base, type: "logout_account", idempotencyKey: "unsupported_08", accountId: "owner_anthropic" },
      {
        ...base,
        type: "remove_account",
        idempotencyKey: "unsupported_09",
        accountId: "owner_anthropic",
        dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
        confirmation: "remove_account",
      },
      {
        ...base,
        type: "reassign_account",
        idempotencyKey: "unsupported_10",
        fromAccountId: "owner_anthropic",
        target: { kind: "access_source", accessSourceId: "matrix_included" },
        scope: "all_dependencies",
        dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      },
      { ...base, type: "set_gateway_budget", idempotencyKey: "unsupported_11", monthlyBudgetMicrousd: 1 },
      { ...base, type: "set_gateway_allowlist", idempotencyKey: "unsupported_12", allowedModelIds: ["claude-sonnet-5"] },
    ];

    for (const mutation of mutations) {
      await expect(store.mutate(mutation)).rejects.toMatchObject({ status: 503 });
    }
  });
});
