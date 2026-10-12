import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayChatProviderCatalog } from "../../packages/gateway/src/chat/runtime-provider-catalog.js";
import { buildKernelCredentialLaunch } from "../../packages/gateway/src/kernel-credentials.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

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
  it("offers an installed Claude Chat route only for the exact funded models", () => {
    const instances = managedChatInstances(makeAiProviderSnapshot(), [], Date.now(), true);
    expect(instances.find((instance) => instance.id === "claude_code_matrix_included")).toMatchObject({
      driverKind: "claude_code", availability: "available", connectionLabel: "Matrix AI",
      models: [{ id: "claude-sonnet-5" }],
      defaultSelection: { instanceId: "claude_code_matrix_included", model: "claude-sonnet-5" },
      supports: { tools: ["integrations", "custom_mcp"] },
    });
    expect(managedChatInstances(makeAiProviderSnapshot(), []).map((instance) => instance.id))
      .toEqual(["kernel_matrix_included"]);
  });

  it("does not offer funded Claude Chat when the relay or model policy is unavailable", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = "unavailable";
    expect(managedChatInstances(snapshot, [], Date.now(), true)
      .find((instance) => instance.id === "claude_code_matrix_included")?.availability)
      .toBe("unavailable");
    snapshot.accessSources[0]!.state = "ready";
    snapshot.accessSources[0]!.eligibleModelIds = [];
    expect(managedChatInstances(snapshot, [], Date.now(), true)
      .find((instance) => instance.id === "claude_code_matrix_included")?.models)
      .toEqual([]);
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

describe("funded native Claude launch", () => {
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
  it("uses a bounded relay lease for the exact Run without owner credential fallback", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "owner-key-must-not-win");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "owner-oauth-must-not-win");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "authorization: owner-token");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "1");
    vi.stubEnv("MATRIX_FUNDED_AI_RUNTIME_TOKEN", "host-control-must-not-leak");
    const { resolveClaudeCredentialLaunch, funded, lease } = fundedFixture();
    const launch = await resolveClaudeCredentialLaunch({ runId: "run_funded_exact", instanceId: "claude_code_matrix_included" });
    expect(funded.getCredential).toHaveBeenCalledWith({ requestClass: "interactive", minValidityMs: 180_000 });
    expect(launch.fundedRunTimeoutMs).toBe(120_000);
    expect(launch.env).toMatchObject({ HOME: home, ANTHROPIC_AUTH_TOKEN: lease.token,
      ANTHROPIC_BASE_URL: lease.relayBaseUrl, ANTHROPIC_CUSTOM_HEADERS: "x-matrix-funded-claim-key: run_funded_exact",
      CLAUDE_CONFIG_DIR: join(home, "system/provider-profiles/claude-matrix") });
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_VERTEX", "MATRIX_FUNDED_AI_RUNTIME_TOKEN"]) {
      expect(launch.env).not.toHaveProperty(name);
    }
    await expect(buildKernelCredentialLaunch(home, {}, "matrix_included", funded)).rejects.toThrow("Selected AI access is unavailable");
  });
  it("does not lease Matrix AI during owner model discovery", async () => {
    const { resolveClaudeCredentialLaunch, funded } = fundedFixture();
    const owner = await resolveClaudeCredentialLaunch();
    expect(funded.getCredential).not.toHaveBeenCalled();
    expect(owner.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test-owner");
  });
  it("fails closed for missing funding, invalid Run keys, and unusable leases", async () => {
    const missing = createGatewayChatProviderCatalog({ ...dependencies, homePath: home });
    await expect(missing.resolveClaudeCredentialLaunch({ runId: "run_test", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    const { resolveClaudeCredentialLaunch, funded, lease } = fundedFixture();
    await expect(resolveClaudeCredentialLaunch({ runId: "run_test\r\nauthorization: other", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    expect(funded.getCredential).not.toHaveBeenCalled();
    lease.expiresAt = new Date(Date.now() + 30_000).toISOString();
    await expect(resolveClaudeCredentialLaunch({ runId: "run_test", instanceId: "claude_code_matrix_included" })).rejects.toThrow();
    await expect(buildKernelCredentialLaunch(home, {}, "matrix_included", funded)).rejects.toThrow("Selected AI access is unavailable");
  });
});
