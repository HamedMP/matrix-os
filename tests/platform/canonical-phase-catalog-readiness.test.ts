import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { JEV_MODEL_ID, type IsolatedChatEnvelope } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createCanonicalPlatformTestDb } from "./canonical-phase-postgres.js";
import * as fundingSources from "../../packages/platform/src/ai-funded-reservation-sources.js";
import { createFundedAiFundingSummaryClient } from "../../packages/gateway/src/funded-ai-funding-summary-client.js";
import { createFundedAiRouteReadinessClient } from "../../packages/gateway/src/funded-ai-route-readiness-client.js";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";

import { createCanonicalPhaseReadiness } from "../../packages/gateway/src/chat/canonical-phase-readiness.js";
import { composePhaseCatalog } from "../../packages/gateway/src/chat/phase-catalog-composition.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const model = "@cf/zai-org/glm-5.3-flash";
const identity = { ownerId: "catalog_owner", machineId: "catalog_machine", runtimeSlot: "primary" };
const at = new Date("2026-10-11T00:00:00.000Z");

async function fixture(canonical = true, promotion = false) {
  const { db, close } = await createCanonicalPlatformTestDb(); cleanup.push(close);
  const homePath = await mkdtemp(join(tmpdir(), "canonical-catalog-")); cleanup.push(() => rm(homePath, { recursive: true, force: true }));
  const secret = "fixture-platform-secret".repeat(2);
  const token = buildPlatformRuntimeVerificationToken({ handle: "catalog", ...identity }, secret);
  const phase: IsolatedChatEnvelope = { ...identity, phaseId: "phase_catalog", chatId: "chat_catalog", modelId: model,
    runtimeTokenEpoch: 1, runtimeCredentialSha256: createHash("sha256").update(token).digest("hex"), sourceSha: "a".repeat(40),
    ...(canonical ? { target: { kind: "canonical_bot" as const, botId: "bot_catalog01", recipeRef: { recipeId: "matrix-bot", version: "1.0.0" } } } : {}),
    startsAt: at.toISOString(), expiresAt: "2026-10-11T00:20:00.000Z" };
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "catalog", runtimeSlot: identity.runtimeSlot,
    status: "running", imageVersion: "fixture", provisionedAt: at.toISOString(), activationState: "authorized" });
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(43), now: () => at });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
  await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1000, expiresAt: null });
  await repository.grantCredit({ identity, entryId: "catalog_fixture_credit", kind: "promotional_grant", amountMicrousd: 1000, sourceReference: "fixture" });
  const readCached = vi.fn(async () => ({ ready: true, checkedAt: at.toISOString(), staleAfter: "2026-10-11T00:10:00.000Z" }));
  const probe = vi.fn(async (): Promise<{ ready: boolean; checkedAt: string; staleAfter: string }> => { throw new Error("Unreviewed warming forbidden"); });
  const platform = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db, repository, platformSecret: secret,
    isolatedChat: phase, promotionalGrant: promotion ? { enabled: true, campaignId: "fixture-campaign", amountMicrousd: 1000, expiresAt: "2026-10-12T00:00:00.000Z" } : undefined, routeProbes: { readCached, probe }, now: () => at }));
  const transport = vi.fn<typeof fetch>(async (url, init) => platform.request(String(url), init));
  const config = { identity, isolatedChat: phase, runtimeAuthToken: token, maxRunMs: 600000, requestTimeoutMs: 5000,
    issueUrl: "https://platform.test/internal/containers/catalog/ai/funded-credential?runtimeSlot=primary", relayBaseUrl: "https://relay.test",
    fundingSummaryUrl: "https://platform.test/internal/containers/catalog/ai/funding-summary?runtimeSlot=primary",
    routeReadinessUrl: "https://platform.test/internal/containers/catalog/ai/route-readiness?runtimeSlot=primary" };
  let actual = { ...identity, runtimeTokenEpoch: 1, credentialSha256: phase.runtimeCredentialSha256, sourceSha: phase.sourceSha };
  let clock = at, principal = identity.ownerId;
  const routeOptions = { identity: () => actual, now: () => clock };
  const scope = createCanonicalPhaseReadiness(config.isolatedChat, routeOptions);
  const summary = createFundedAiFundingSummaryClient(config, { fetchFn: transport, ...routeOptions });
  const routes = createFundedAiRouteReadinessClient(config, transport, routeOptions);
  const native = vi.fn(async () => ({ providers: [], accessSources: [], failures: [] }));
  const driver = vi.fn(async () => []);
  const health = vi.fn(async () => null);
  const api = vi.fn(async () => undefined);
  const plan = vi.fn(async () => undefined);
  const local = vi.fn(async () => undefined);
  const providers = new AiProviderService({ homePath, env: { MATRIX_FUNDED_AI_ENABLED: "true", ANTHROPIC_API_KEY: "fixture-owner-key" }, observationScope: scope.observationScope, now: () => at,
    fundedCredentialProvider: { enabled: true, maxRunMs: 600000, getCredential: async () => { throw new Error("No issuance"); }, invalidate: () => {}, close: () => {} },
    fundedReadinessReader: createFundedAiReadinessReader({ summary, routes, now: () => at }),
    driverInventory: driver, healthProbe: health, nativeHarnessCatalogReader: { getCatalog: native },
    matrixAnthropicConnection: api, chatGptPlanObservation: plan, codexNativeKeyReadiness: local as never });
  cleanup.push(async () => providers.close());
  const settings = new ProviderSettingsStore({ homePath, observationScope: scope.observationScope, providerSnapshotReader: providers, fundingSummaryReader: summary, now: () => at });
  const coding = vi.fn(async () => []), runtime = vi.fn(async () => { throw new Error("No native observation"); });
  const base = createChatProviderCatalogService({ codingProviders: { listProviders: coding, invalidate: vi.fn() },
    agentRuntimeSource: runtime, aiProviderSource: providers, harnessSettingsSource: settings, now: () => at,
    observationScope: scope.observationScope });
  const decorator = vi.fn((catalog: typeof base) => catalog);
  const catalog = composePhaseCatalog(base, scope.canonical, decorator);
  const ui = new Hono().route("/", createChatProviderRoutes({ catalog, getPrincipal: () => ({ userId: principal, source: "jwt" }) }));
  return { db, phase, config, platform, token, repository, secret, ui, routes, providers, settings, decorator, routeOptions, scope,
    setActual: (patch: Partial<typeof actual>) => { actual = { ...actual, ...patch }; },
    setClock: (next: Date) => { clock = next; }, setPrincipal: (next: string) => { principal = next; }, native, driver, health, api, plan, local, coding, runtime, readCached, probe, transport };
}

it("routes real UI catalog refresh through both provider/settings snapshots to cache-only funding without native or API observations", async () => {
  const f = await fixture();
  const response = await f.ui.request("/api/chat-providers?refresh=true&includeConnectionState=true");
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(catalog.instances.find((instance: { id: string }) => instance.id === "matrix_pi_default")).toMatchObject({ availability: "available",
    models: expect.arrayContaining([expect.objectContaining({ id: model, availability: "available" })]) });
  for (const unrelated of [f.native, f.driver, f.health, f.api, f.plan, f.local, f.coding, f.runtime]) expect(unrelated).not.toHaveBeenCalled();
  expect(f.readCached).toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled(); expect(f.decorator).not.toHaveBeenCalled();
  expect(f.transport.mock.calls.some(([url]) => String(url).includes("funded-credential"))).toBe(false);
});

 it("independent Platform canonical Jev readiness is denied before any probe or cache observation", async () => {
  const f = await fixture(true);
  const reply = await f.platform.request(f.config.routeReadinessUrl, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: JSON.stringify({ modelId: JEV_MODEL_ID }) });
  expect(reply.status).toBe(503); expect(f.probe).not.toHaveBeenCalled(); expect(f.readCached).not.toHaveBeenCalled();
});
it("Gateway canonical Jev readiness is denied before transport", async () => {
  const f = await fixture(true);
  const client = createFundedAiRouteReadinessClient(f.config, f.transport);
  await expect(client.getRouteReadiness({ modelId: JEV_MODEL_ID })).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});

const invalidFacts = ["owner", "machine", "slot", "epoch", "credential", "source", "expiry", "future", "principal"] as const;
it.each(invalidFacts)("UI phase rejects %s before all observations, including public scope hints", async kind => {
  const f = await fixture();
  if (kind === "owner") f.setActual({ ownerId: "other" });
  if (kind === "machine") f.setActual({ machineId: "other" });
  if (kind === "slot") f.setActual({ runtimeSlot: "other" });
  if (kind === "epoch") f.setActual({ runtimeTokenEpoch: 2 });
  if (kind === "credential") f.setActual({ credentialSha256: "b".repeat(64) });
  if (kind === "source") f.setActual({ sourceSha: "b".repeat(40) });
  if (kind === "expiry") f.setClock(new Date(f.phase.expiresAt));
  if (kind === "future") f.setClock(new Date(+at - 1));
  if (kind === "principal") f.setPrincipal("foreign_owner");
  expect((await f.ui.request("/api/chat-providers?refresh=true&admissionScope=managed_matrix&cacheOnly=false")).status).toBe(503);
  for (const observed of [f.native, f.driver, f.health, f.api, f.plan, f.local, f.coding, f.runtime, f.transport]) expect(observed).not.toHaveBeenCalled();
});
it.each(["miss", "stale", "unavailable"])("UI cache %s preserves safe catalog shape without warming", async kind => {
  const f = await fixture();
  if (kind === "unavailable") f.readCached.mockRejectedValue(new Error("fixture cache unavailable"));
  else f.readCached.mockResolvedValue({ ready: kind !== "miss", checkedAt: at.toISOString(), staleAfter: kind === "stale" ? at.toISOString() : "2026-10-11T00:10:00.000Z" });
  const response = await f.ui.request("/api/chat-providers"); expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(catalog.instances.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(["matrix_pi_default", "hermes_default", "openclaw_default", "codex_default", "pi_default"]));
  expect(catalog.instances.find((i: { id: string }) => i.id === "matrix_pi_default").availability).toBe("unavailable");
  expect(f.probe).not.toHaveBeenCalled(); expect(f.coding).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled();
});
it("trusted service scope also upgrades managed admission and independent Settings snapshots", async () => {
  const f = await fixture();
  await f.providers.getSnapshot({ admissionScope: "managed_matrix" }); await f.settings.getSnapshot();
  for (const observed of [f.native, f.driver, f.health, f.api, f.plan, f.local, f.coding, f.runtime]) expect(observed).not.toHaveBeenCalled();
  f.setActual({ sourceSha: "b".repeat(40) }); f.transport.mockClear();
  await expect(f.providers.getSnapshot()).rejects.toThrow(); await expect(f.settings.getSnapshot()).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});
it.each(["missing", "source", "target", "window", "epoch"])("Platform rejects %s phase binding independently of Gateway", async kind => {
  const f = await fixture(); const phase = { ...f.phase };
  if (kind === "source") phase.sourceSha = "b".repeat(40);
  if (kind === "target") phase.target = { ...phase.target!, kind: "canonical_bot", botId: "bot_different1", recipeRef: { recipeId: "matrix-bot", version: "1.0.0" } };
  if (kind === "window") phase.expiresAt = "2026-10-11T00:19:00.000Z";
  if (kind === "epoch") phase.runtimeTokenEpoch = 2;
  const digest = createCanonicalPhaseReadiness(phase, f.routeOptions).digest!;
  const response = await f.platform.request(f.config.routeReadinessUrl, { method: "POST", body: "{}", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-matrix-isolated-chat-phase": f.phase.phaseId,
    ...(kind === "missing" ? {} : { "x-matrix-isolated-chat-config": digest }) } });
  expect(response.status).toBe(503); expect(f.readCached).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
});
it("unconfigured canonical scope preserves ordinary catalog discovery and decoration", async () => {
  const f = await fixture(false); expect((await f.ui.request("/api/chat-providers?refresh=true")).status).toBe(200);
  for (const key of ["native", "driver", "api", "plan", "local", "coding", "runtime", "decorator"] as const) expect(f[key], key).toHaveBeenCalled();
});

it("Gateway rejects missing trusted identity, changed transport binding, and unsupported selections before fetching", async () => {
  const f = await fixture();
  for (const [config, facts, modelId] of [
    [f.config, {}, undefined],
    [{ ...f.config, identity: { ...identity, ownerId: "other_owner" } }, f.routeOptions, undefined],
    [f.config, f.routeOptions, "unsupported/model"],
    [f.config, f.routeOptions, model],
  ] as const) {
    const reader = createFundedAiRouteReadinessClient(config, f.transport, facts);
    await expect(reader.getRouteReadiness({ modelId } as never)).rejects.toThrow();
  }
  expect(f.transport).not.toHaveBeenCalled();
});
it.each(["owner", "machine", "slot", "epoch", "credential", "expiry", "future"])("Platform canonical %s mismatch never falls back to probes", async kind => {
  const f = await fixture(); const phase = { ...f.phase };
  if (kind === "owner") phase.ownerId = "other_owner";
  if (kind === "machine") phase.machineId = "other_machine";
  if (kind === "slot") phase.runtimeSlot = "other-slot";
  if (kind === "epoch") phase.runtimeTokenEpoch = 2;
  if (kind === "credential") phase.runtimeCredentialSha256 = "c".repeat(64);
  const clock = kind === "expiry" ? new Date(phase.expiresAt) : kind === "future" ? new Date(+at - 1) : at;
  const platform = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db: f.db, repository: f.repository,
    platformSecret: f.secret, isolatedChat: phase, routeProbes: { readCached: f.readCached, probe: f.probe }, now: () => clock }));
  const response = await platform.request(f.config.routeReadinessUrl, { method: "POST", body: "{}", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-matrix-isolated-chat-phase": phase.phaseId,
    "x-matrix-isolated-chat-config": createCanonicalPhaseReadiness(phase, f.routeOptions).digest! } });
  expect(response.status).toBe(503); expect(f.readCached).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
});
it("source changes while a valid catalog read is in flight fail closed on completion", async () => {
  const f = await fixture();
  f.readCached.mockImplementation(async () => { f.setActual({ sourceSha: "b".repeat(40) }); return { ready: true, checkedAt: at.toISOString(), staleAfter: "2026-10-11T00:10:00.000Z" }; });
  expect((await f.ui.request("/api/chat-providers")).status).toBe(503); expect(f.probe).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
});

it("canonical catalog under enabled promotion reads funding without grants or balancing writes", async () => {
  const f = await fixture(true, true);
  const grant = vi.spyOn(f.repository, "grantCredit"), mutableSummary = vi.spyOn(f.repository, "getRuntimeFundingSummary");
  const before = await f.db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute();
  const ledgerBefore = await f.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute();
  const response = await f.ui.request("/api/chat-providers?refresh=true"); expect(response.status).toBe(200);
  expect((await response.json()).instances.find((i: { id: string }) => i.id === "matrix_pi_default").availability).toBe("available");
  expect(grant).not.toHaveBeenCalled(); expect(mutableSummary).not.toHaveBeenCalled();
  expect(await f.db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute()).toEqual(before);
  expect(await f.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual(ledgerBefore);
});

it("foreign Platform runtimes retain ordinary probes and reject private phase hints", async () => {
  const f = await fixture(); const foreign = { ownerId: "foreign_owner", machineId: "foreign_machine", runtimeSlot: "primary" };
  await insertUserMachine(f.db, { ...foreign, clerkUserId: foreign.ownerId, handle: "foreign", status: "running", imageVersion: "fixture", provisionedAt: at.toISOString(), activationState: "authorized" });
  await f.repository.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [model, JEV_MODEL_ID] });
  await f.repository.setRuntimePolicy({ identity: foreign, expectedRevision: 0, enabled: true, allowedModelIds: [model, JEV_MODEL_ID], monthlyBudgetMicrousd: 1000, expiresAt: null });
  await f.repository.grantCredit({ identity: foreign, entryId: "foreign_fixture_credit", kind: "promotional_grant", amountMicrousd: 1000, sourceReference: "fixture" });
  f.probe.mockResolvedValue({ ready: true, checkedAt: at.toISOString(), staleAfter: "2026-10-11T00:10:00.000Z" });
  const token = buildPlatformRuntimeVerificationToken({ handle: "foreign", ...foreign }, f.secret);
  const request = (headers: Record<string, string> = {}, modelId?: typeof JEV_MODEL_ID) => f.platform.request("https://platform.test/internal/containers/foreign/ai/route-readiness?runtimeSlot=primary", {
    method: "POST", body: JSON.stringify({ modelId }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers } });
  expect((await request()).status).toBe(200); expect(f.probe).toHaveBeenCalledWith(model, expect.anything());
  expect((await request({}, JEV_MODEL_ID)).status).toBe(200); expect(f.probe).toHaveBeenCalledWith(JEV_MODEL_ID, expect.anything());
  f.probe.mockClear();
  for (const header of [{ "x-matrix-isolated-chat-phase": f.phase.phaseId }, { "x-matrix-isolated-chat-config": f.scope.digest! }]) expect((await request(header)).status).toBe(503);
  expect(f.probe).not.toHaveBeenCalled(); expect(f.readCached).not.toHaveBeenCalled();
});
it("ordinary funding summary retains promotion while canonical missing hint cannot invoke it", async () => {
  const f = await fixture(false, true); const grant = vi.spyOn(f.repository, "grantCredit");
  expect((await f.ui.request("/api/chat-providers")).status).toBe(200); expect(grant).toHaveBeenCalled();
  const scoped = await fixture(true, true); const scopedGrant = vi.spyOn(scoped.repository, "grantCredit"), summary = vi.spyOn(scoped.repository, "getRuntimeFundingSummary");
  const response = await scoped.platform.request(scoped.config.fundingSummaryUrl, { method: "POST", body: "{}", headers: { authorization: `Bearer ${scoped.token}`, "content-type": "application/json" } });
  expect(response.status).toBe(503); expect(scopedGrant).not.toHaveBeenCalled(); expect(summary).not.toHaveBeenCalled();
});

it("canonical UI preserves four ordinary account-route descriptors as unavailable without observing accounts", async () => {
  const f = await fixture(); const response = await f.ui.request("/api/chat-providers?refresh=true"); expect(response.status).toBe(200);
  const catalog = await response.json();
  for (const id of ["matrix_anthropic_api", "matrix_pi_anthropic_api", "matrix_chatgpt_plan", "matrix_pi_chatgpt_plan"]) {
    expect(catalog.instances.find((i: { id: string }) => i.id === id), id).toMatchObject({ id, availability: "unavailable", models: [], options: [] });
  }
  expect(f.api).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled(); expect(f.decorator).not.toHaveBeenCalled();
});

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("real PostgreSQL rejects a balancing write injected inside canonical read-only funding source projection", async () => {
  const f = await fixture(true, true); let actualCode: unknown;
  const before = await f.db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute();
  vi.spyOn(fundingSources, "fundingSourceAvailability").mockImplementation(async executor => {
    try { await executor.updateTable("ai_funded_runtime_balances").set({ credit_balance_microusd: 999 }).execute(); }
    catch (error) { actualCode = (error as { code?: string }).code; throw error; }
    throw new Error("Postgres read-only enforcement missing");
  });
  const response = await f.platform.request(f.config.fundingSummaryUrl, { method: "POST", body: JSON.stringify({ includeChatAvailability: true }),
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", ...f.scope.requestHeaders(f.config) } });
  expect(response.status).toBe(503); expect(actualCode).toBe("25006");
  expect(await f.db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute()).toEqual(before);
});

it.each(["owner", "machine", "slot", "token"])("canonical funding-summary %s transport binding mismatch fails before all transport", async kind => {
  const f = await fixture(); const config = { ...f.config, identity: { ...f.config.identity } };
  if (kind === "owner") config.identity.ownerId = "other_owner";
  if (kind === "machine") config.identity.machineId = "other_machine";
  if (kind === "slot") config.identity.runtimeSlot = "other-slot";
  if (kind === "token") config.runtimeAuthToken = "different-runtime-token";
  const summary = createFundedAiFundingSummaryClient(config, { fetchFn: f.transport, ...f.routeOptions });
  await expect(summary.getFundingSummary()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("canonical summary refuses legacy compatibility retry after a strict Platform rejection", async () => {
  const f = await fixture();
  const fetchFn = vi.fn(async () => Response.json({ error: { code: "invalid_request", message: "Invalid request" } }, { status: 400 }));
  const summary = createFundedAiFundingSummaryClient(f.config, { fetchFn, ...f.routeOptions });
  await expect(summary.getFundingSummary()).rejects.toThrow("Matrix AI usage is temporarily unavailable");
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
