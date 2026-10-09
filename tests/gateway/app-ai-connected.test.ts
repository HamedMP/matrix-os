import { expect, it, vi } from "vitest";
import { AppAiInputSchema, createAppAiClient } from "../../packages/contracts/src/app-ai.js";
import { projectAppAiRoutes } from "../../packages/gateway/src/app-ai/connected-routes.js";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
const route = { harnessId: "harness_pi", accountId: null, accessSourceId: "pi_openai", modelId: "openai:gpt-5" };
const now = new Date();
function settings(): ProviderSettingsSnapshot {
    return { projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
        harnesses: [{ id: "harness_pi", harness: "pi", displayName: "Pi", enabled: true, installState: "installed", authState: "authenticated", connectivity: "online", selectedAccountId: null, accessSourceId: "pi_openai", route: { kind: "configurable", providerId: "openai", modelId: "openai:gpt-5" } }],
        accessSources: [{ id: "pi_openai", kind: "harness_profile", harness: "pi", providerId: "openai", accountId: null, fundingKind: "harness_owned", eligibleModelIds: ["openai:gpt-5"], readiness: { state: "ready", staleAfter: null } }],
        accounts: [], modelProviders: [{ id: "openai", models: [{ id: "openai:gpt-5", displayName: "GPT-5", enabled: true }] }]
    } as unknown as ProviderSettingsSnapshot;
}
it("discovers exact connected non-Claude routes and disables stale/disabled choices", () => {
    const value = settings();
    expect(projectAppAiRoutes(value, undefined, now).routes).toContainEqual(expect.objectContaining({ ...route, availability: "available", readiness: "ready" }));
    value.harnesses[0]!.enabled = false;
    expect(projectAppAiRoutes(value, undefined, now).routes[0]).toMatchObject({ availability: "unavailable", reason: "disabled" });
    value.harnesses[0]!.enabled = true;
    value.accessSources[0]!.readiness.staleAfter = "2020-01-01T00:00:00.000Z";
    expect(projectAppAiRoutes(value, undefined, now).routes[0]).toMatchObject({ availability: "unavailable", reason: "not_ready" });
});
it("does not advertise unsafe general Chat harnesses as app completions", () => {
    const value = settings();
    value.harnesses[0]!.harness = "codex";
    expect(projectAppAiRoutes(value, undefined, now).routes[0]).toMatchObject({ availability: "unavailable", reason: "completion_unavailable" });
});
it("validates explicit selection and supports secret-free route discovery clients", async () => {
    expect(AppAiInputSchema.parse({ prompt: "notes", route })).toEqual({ prompt: "notes", route });
    const generate = vi.fn(async () => ({ text: "result" }));
    const client = createAppAiClient(generate, async () => ({ routes: [], defaultRoute: null }));
    expect(await client.routes()).toEqual({ routes: [], defaultRoute: null });
    expect(await client.generate({ prompt: "notes", route })).toEqual({ text: "result" });
    expect(generate).toHaveBeenCalledWith({ prompt: "notes", route });
    expect(AppAiInputSchema.safeParse({ prompt: "notes", route: { ...route, token: "bad" } }).success).toBe(false);
});
it("exposes exact authenticated Claude subscription profile without inventing ready inference", () => {
    const value = settings();
    const harness = value.harnesses[0]!;
    harness.harness = "claude";
    harness.selectedAccountId = "claude_account";
    harness.accessSourceId = "owner_claude_profile";
    harness.route = { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" };
    value.accounts = [{ id: "claude_account", authState: "authenticated", authMethod: "terminal", accessSourceId: "owner_claude_profile", lastCheckedAt: now.toISOString(), connectionDetails: { email: "owner@example.test" } }] as never;
    value.accessSources = [{ id: "owner_claude_profile", kind: "provider_account", providerId: "anthropic", accountId: "claude_account", fundingKind: "owner_account", eligibleModelIds: ["claude-sonnet-5"], readiness: { state: "unknown", staleAfter: null } }] as never;
    value.modelProviders = [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "claude-sonnet-5", displayName: "Sonnet", enabled: true }] }];
    const canonical = { instances: [{ driverId: "claude_code", accountId: "claude_account", accessSourceId: "owner_claude_profile", modelIds: ["claude-sonnet-5"] }], accessSources: [], models: [] } as never;
    expect(projectAppAiRoutes(value, canonical, now).routes[0]).toMatchObject({ accountId: "claude_account", availability: "available", readiness: "local_profile" });
    value.accounts[0]!.id = "another_account";
    expect(projectAppAiRoutes(value, canonical, now).routes[0]).toMatchObject({ availability: "unavailable" });
});
it("offers all enabled models on the exact connected source, preserving account binding", () => {
    const value = settings();
    value.accessSources[0]!.eligibleModelIds.push("openai:gpt-5-mini");
    value.modelProviders[0]!.models.push({ id: "openai:gpt-5-mini", displayName: "GPT-5 Mini", enabled: true });
    expect(projectAppAiRoutes(value, undefined, now).routes).toContainEqual(expect.objectContaining({ ...route, modelId: "openai:gpt-5-mini", availability: "available" }));
});
