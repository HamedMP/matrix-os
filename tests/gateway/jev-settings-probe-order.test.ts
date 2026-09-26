import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ChatRunContextSchema, JEV_MODEL_ID, type ChatAgent } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProductionJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-production.js";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { baseInput, fakeGateway } from "./hermes-test-gateway.js";
import { saved } from "../desktop/chat-agents-fixture.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jev-settings-order-")); const home = join(directory, "home");
  await mkdir(join(home, "system/ai-providers"), { recursive: true });
  await writeFile(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-api03-synthetic-only" } }));
  const config = { schemaVersion: 1, revision: 1, receipts: [], gatewayPolicy: null,
    accountProfiles: [{ id: "owner_anthropic", providerId: "anthropic", displayName: "Owner", authMethod: "api_key", accessSourceId: "owner_anthropic_key" }],
    harnesses: [{ id: "harness_hermes", driverId: "hermes", harness: "hermes", displayName: "Hermes", accentColor: null, enabled: true,
      selectedAccountId: "owner_anthropic", accessSourceId: "owner_anthropic_key", route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" } }] };
  const configPath = join(home, "system/ai-providers/settings.json"); await writeFile(configPath, JSON.stringify(config));
  const genericProbe = vi.fn(async () => ({ readiness: { state: "ready" as const, checkedAt: new Date().toISOString(),
    staleAfter: new Date(Date.now() + 30_000).toISOString(), action: "none" as const, safeReason: null },
    allowedModelIds: ["claude-sonnet-5", "@cf/zai-org/glm-5.3-flash"] }));
  const service = new AiProviderService({ homePath: home, env: {},
    fundedCredentialProvider: { enabled: true, maxRunMs: 600_000, getCredential: async () => { throw new Error("no credential acquisition during read"); }, invalidate() {}, close() {} },
    fundedReadinessReader: { read: genericProbe },
    healthProbe: async () => ({ state: "ready", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60_000).toISOString(), action: "none", safeReason: null }),
    driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed", health: "ready", capabilities: ["tools", "resume"], setupActions: [] }] });
  const settings = new ProviderSettingsStore({ homePath: home, privateRootPath: join(directory, "private"), providerSnapshotReader: service });
  const now = new Date();
  const policy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [JEV_MODEL_ID], monthlyBudgetMicrousd: 10_000_000,
    checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 60_000).toISOString() };
  const funding = { topUpEnabled: false, asOf: now.toISOString(), periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    monthlyBudgetMicrousd: 10_000_000, settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
    promotionalBalanceMicrousd: 5_000_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 5_000_000, remainingBalanceMicrousd: 5_000_000, remainingBudgetMicrousd: 10_000_000 };
  const account = { service: "gmail" as const, accountLabel: "Work", connectionId: "conn_fixture", expectedEmail: "me@example.test" };
  const agent: ChatAgent = { ...saved, selection: { instanceId: "hermes_default", model: "anthropic:claude-sonnet-5" }, recipe: {
    skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }], output: "Read-only proposals",
    jevInboxTriage: { version: 1, ownerId: baseInput.owner.ownerId, ...account } } };
  const paidJev = vi.fn(); const primary = fakeGateway(); const profile = vi.fn(async () => ({ emailAddress: "foreign@example.test" }));
  const runtime = createProductionJevInboxRuntime({ homePath: home, ownerId: baseInput.owner.ownerId, fundedOwnerId: "funded_fixture", settings,
    getAgent: async () => agent, service: { evaluate: paidJev }, summary: { getFundingSummary: async () => ({ policy, funding }) },
    routes: { getRouteReadiness: paidJev }, internalBaseUrl: null,
    db: { listConnectedServices: async () => [{ id: account.connectionId, user_id: baseInput.owner.ownerId, service: "gmail", status: "active",
      account_label: "Work", account_email: account.expectedEmail, pipedream_account_id: "apn_fixture" }],
      getUserById: async () => ({ pipedream_external_id: "external_fixture" }) } as unknown as PlatformDb,
    pipedream: { boundedGmailGet: profile } as unknown as PipedreamConnectClient });
  const context = ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [], agent: {
    id: agent.id, revision: agent.revision, name: agent.name, instructions: agent.instructions, recipe: {
      skills: [{ id: "matrix-jev-email-triage", name: "Jev", instructions: "Preview", sha256: "a".repeat(64) }], integrations: agent.recipe!.integrations,
      output: "Read-only proposals", jevInboxTriage: agent.recipe!.jevInboxTriage } } });
  return { runtime, settings, genericProbe, paidJev, primary, profile, context, agent, configPath,
    close: async () => { runtime.close(); service.close(); await rm(directory, { recursive: true, force: true }); } };
}

it.each(["pin", "catalog", "profile"])("real production resolver → SettingsStore → V3 cannot pay generic probes before rejected %s", async mode => {
  const f = await fixture();
  try {
    await f.runtime.admit(baseInput.owner.ownerId, f.agent);
    const launch = { ...f.runtime.launch, verifyRuntime: async () => { if (mode === "pin") throw new Error("synthetic pin denial"); } };
    const adapter = createHermesChatProviderAdapter({ homePath: "/synthetic", spawnFn: f.primary.spawnFn, jev: launch });
    const completed = (async () => { const events = []; for await (const event of adapter.start({ ...baseInput, context: f.context, selection: f.agent.selection })) events.push(event); return events; })();
    const rejection = mode === "pin" ? expect(completed).rejects.toThrow() : completed;
    if (mode !== "pin") {
      await vi.waitFor(() => expect(f.primary.requests.some(request => request.method === "session.create")).toBe(true));
      f.primary.event("session.info", { lazy: false, tools: { matrix_jev_recipe: mode === "catalog" ? ["forged_tool"] : ["mcp__matrix_jev_recipe__jev_inbox_preview"] } });
    }
    await rejection;
    expect(f.genericProbe).not.toHaveBeenCalled(); expect(f.paidJev).not.toHaveBeenCalled();
    expect(f.primary.requests.some(request => request.method === "prompt.submit")).toBe(false);
    expect(f.profile).toHaveBeenCalledTimes(mode === "profile" ? 1 : 0);
    expect(JSON.parse(await readFile(f.configPath, "utf8")).harnesses[0].enabled).toBe(true);
  } finally { await f.close(); }
});

it("ordinary Settings still reads generic funded readiness and preserves selected API-key projection", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.settings.getSnapshot({ refresh: true });
    expect(f.genericProbe).toHaveBeenCalledTimes(1);
    expect(snapshot.harnesses.find(harness => harness.harness === "hermes")).toMatchObject({ enabled: true, accessSourceId: "owner_anthropic_key", selectedAccountId: "owner_anthropic" });
    expect(snapshot.accessSources.find(source => source.id === "owner_anthropic_key")?.readiness.state).toBe("ready");
  } finally { await f.close(); }
});

it("suppressed real Settings reads never promote Matrix readiness or persist transient owner-off intent", async () => {
  const f = await fixture();
  try {
    // Initialize normal reconciliation first so the equality check concerns durable intent,
    // not expected first-read additions of discovered drivers/accounts.
    await f.settings.getSnapshot({ refresh: true }); f.genericProbe.mockClear();
    const before = await readFile(f.configPath, "utf8");
    const snapshot = await f.settings.getSnapshot({ refresh: true, suppressFundedProbes: true });
    expect(f.genericProbe).not.toHaveBeenCalled();
    const matrix = snapshot.accessSources.filter(source => source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon");
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.every(source => source.readiness.state !== "ready")).toBe(true);
    expect(snapshot.accessSources.find(source => source.id === "owner_anthropic_key")?.readiness.state).toBe("ready");
    expect(await readFile(f.configPath, "utf8")).toBe(before);
  } finally { await f.close(); }
});
