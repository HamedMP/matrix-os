import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayChatProviderCatalog } from "../../packages/gateway/src/chat/runtime-provider-catalog.js";
import { buildKernelCredentialLaunch } from "../../packages/gateway/src/kernel-credentials.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances, managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

function expectUnavailableManagedRoute(snapshot: ReturnType<typeof makeAiProviderSnapshot>) {
  const instances = managedChatInstances(snapshot, []);
  expect(instances).toHaveLength(1);
  expect(instances[0]).toMatchObject({
    id: "kernel_matrix_included", connectionLabel: "Matrix AI",
    availability: "unavailable", connectionState: "unavailable", models: [], options: [],
  });
  expect(instances[0]?.defaultSelection).toBeUndefined();
}

describe("managed Chat catalog", () => {
  it("keeps funded Claude models in Matrix Pi without a native Claude Chat entry", () => {
    const instances = managedChatInstances(makeAiProviderSnapshot(), [], Date.now());
    expect(instances.map(instance => instance.id)).toEqual(["kernel_matrix_included"]);
    expect(managedPiChatInstances(makeAiProviderSnapshot())[0]).toMatchObject({
      id: "matrix_pi_default", driverKind: "matrix_pi", availability: "available",
      models: [{ id: "claude-sonnet-5" }],
      defaultSelection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
    });
    expect(managedChatInstances(makeAiProviderSnapshot(), []).map((instance) => instance.id))
      .toEqual(["kernel_matrix_included"]);
  });

  it("does not add a native Claude entry when funding becomes unavailable", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = "unavailable";
    expect(managedChatInstances(snapshot, [], Date.now()).map(instance => instance.id))
      .toEqual(["kernel_matrix_included"]);
    snapshot.accessSources[0]!.state = "ready";
    snapshot.accessSources[0]!.eligibleModelIds = [];
    expect(managedChatInstances(snapshot, [], Date.now()).map(instance => instance.id))
      .toEqual(["kernel_matrix_included"]);
  });

  it("projects the ready managed route without inventing an agent or account", () => {
    const [instance] = managedChatInstances(makeAiProviderSnapshot(), []);
    expect(instance).toMatchObject({
      id: "kernel_matrix_included", driverKind: "kernel", displayName: "Matrix AI",
      availability: "available", defaultSelection: {
        instanceId: "kernel_matrix_included", model: "claude-sonnet-5",
      },
    });
    expect(instance?.models.map((model) => model.id)).toEqual(["claude-sonnet-5"]);
  });

  it.each(["setup_required", "unavailable", "unknown", "expired"] as const)("retains a non-runnable Matrix AI route for a %s access source", (state) => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = state;
    expectUnavailableManagedRoute(snapshot);
  });

  it("keeps stale relay readiness and unavailable instances non-runnable", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.staleAfter = "2000-01-01T00:00:00.000Z";
    expectUnavailableManagedRoute(snapshot);
    snapshot.accessSources[0]!.staleAfter = null;
    snapshot.instances[0]!.readiness.state = "unavailable";
    expectUnavailableManagedRoute(snapshot);
  });

  it("intersects the model and source policies without silently replacing a saved model", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.instances[0]!.defaultModelId = null;
    expect(managedChatInstances(snapshot, [])[0]?.defaultSelection).toBeUndefined();
    snapshot.accessSources[0]!.eligibleModelIds = [];
    expectUnavailableManagedRoute(snapshot);
  });

  it("does not invent readiness without a snapshot or a matching managed source", () => {
    expect(managedChatInstances(undefined, [])).toEqual([]);
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources = [];
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });
});

describe("subscription-only native Claude launch", () => {
  let home: string;
  const dependencies = {
    codingProviders: { listProviders: async () => [], invalidate: () => {} },
    agentRuntimeSource: async () => { throw new Error("Runtime discovery was not requested"); },
    executableDriverKinds: ["claude_code"] as const,
  };
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-funded-claude-launch-"));
    await mkdir(join(home, "system/ai-providers"), { recursive: true });
    await writeFile(join(home, "system/ai-providers/anthropic-key.json"), JSON.stringify({ version: 1, apiKey: "sk-ant-test-owner" }), { mode: 0o600 });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "test-owner-profile" } }));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
  function fundedFixture() {
    const lease = { token: "funded-test-token-01234567890123456789", tokenId: "test-token-id",
      expiresAt: new Date(Date.now() + 900_000).toISOString(), relayBaseUrl: "https://relay.example.test",
      maxRunMs: 120_000, requestClass: "interactive" as const };
    const funded = { enabled: true as const, maxRunMs: 120_000, getCredential: vi.fn(async () => lease),
      invalidate: vi.fn(), close: vi.fn() };
    const runtime = createGatewayChatProviderCatalog({ ...dependencies, homePath: home,
      fundedCredentialProvider: funded });
    return { ...runtime, funded, lease };
  }
  it("rejects a retired funded selection without acquiring a lease or switching account", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "owner-key-must-not-win");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "owner-oauth-must-not-win");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "authorization: owner-token");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "1");
    vi.stubEnv("MATRIX_FUNDED_AI_RUNTIME_TOKEN", "host-control-must-not-leak");
    const { resolveClaudeCredentialLaunch, funded } = fundedFixture();
    await expect(resolveClaudeCredentialLaunch({ runId: "run_funded_exact", instanceId: "claude_code_matrix_included" }))
      .rejects.toThrow("Selected AI access is unavailable");
    expect(funded.getCredential).not.toHaveBeenCalled();
  });
  it("uses the subscription for discovery and normal launch while preserving a separate API key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key-must-not-win");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth-must-not-win");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/foreign-profile");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "1");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("CLAUDE_CODE_USE_FOUNDRY", "1");
    const { resolveClaudeCredentialLaunch, funded } = fundedFixture();
    const keyPath = join(home, "system/ai-providers/anthropic-key.json");
    const profilePath = join(home, ".claude.json");
    const before = await Promise.all([readFile(keyPath, "utf8"), readFile(profilePath, "utf8")]);
    for (const context of [undefined, { runId: "run_subscription", instanceId: "claude_code_default" }]) {
      const owner = await resolveClaudeCredentialLaunch(context);
      expect(owner.env?.HOME).toBe(home);
      expect(owner.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(owner.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(owner.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
      for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY"]) expect(owner.env).not.toHaveProperty(name);
    }
    expect(funded.getCredential).not.toHaveBeenCalled();
    expect(await Promise.all([readFile(keyPath, "utf8"), readFile(profilePath, "utf8")])).toEqual(before);
    expect((await buildKernelCredentialLaunch(home, {}, "owner_anthropic_key", undefined, { requestClass: "interactive" })).env?.ANTHROPIC_API_KEY)
      .toBe("sk-ant-test-owner");
  });
  it("rejects retired selections and never falls back to an API key without subscription login", async () => {
    const missing = createGatewayChatProviderCatalog({ ...dependencies, homePath: home });
    await expect(missing.resolveClaudeCredentialLaunch({ runId: "run_test", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    const { resolveClaudeCredentialLaunch, funded } = fundedFixture();
    await expect(resolveClaudeCredentialLaunch({ runId: "run_test\r\nauthorization: other", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    expect(funded.getCredential).not.toHaveBeenCalled();
    await rm(join(home, ".claude.json"));
    await expect(resolveClaudeCredentialLaunch({ runId: "run_subscription", instanceId: "claude_code_default" })).rejects.toThrow();
    await expect(resolveClaudeCredentialLaunch({ runId: "run_test", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    await expect(buildKernelCredentialLaunch(home, {}, "matrix_included", funded, { requestClass: "interactive" })).rejects.toThrow("Selected AI access is unavailable");
  });
});
