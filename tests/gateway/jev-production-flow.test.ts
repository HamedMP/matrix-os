import { Hono } from "hono";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID, FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiRouteReadinessReceiptSchema, type ChatAgent } from "@matrix-os/contracts";
import type { JevService } from "../../packages/gateway/src/jev/service.js";
import { createProductionJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-production.js";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { issueHermesIntegrationCapability, type HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
import { jevReadySettingsSnapshot } from "../fixtures/jev-inbox.js";
import { saved } from "../desktop/chat-agents-fixture.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes, createAiFundedRelayRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createFundedModelProbeService } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { loadFundedAiRuntimeConfig } from "../../packages/gateway/src/funded-ai-credential-manager.js";
import { createFundedAiFundingSummaryClient } from "../../packages/gateway/src/funded-ai-funding-summary-client.js";
import { createFundedAiRouteReadinessClient } from "../../packages/gateway/src/funded-ai-route-readiness-client.js";

afterEach(() => vi.unstubAllGlobals());
async function fixture(mode = "ready") {
  const now = Date.now(); const home = await mkdtemp(join(tmpdir(), "jev-production-flow-"));
  await mkdir(join(home, "system"));
  await writeFile(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-api03-synthetic-only" } }));
  const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: saved.id, revision: 1,
    account: { service: "gmail", accountLabel: "Work", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
  const agent: ChatAgent = { ...saved, selection: { instanceId: "hermes_default", model: "anthropic:claude-sonnet-5" }, recipe: {
    skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }],
    output: "Read-only proposals", jevInboxTriage: { version: 1, ownerId: "owner_fixture", ...scope.account } } };
  const settings = jevReadySettingsSnapshot(now);
  if (mode === "unsupported") settings.accounts[0]!.authMethod = "oauth";
  const calls: { target: URL; method: string }[] = [];
  const date = (id: string) => String(now - (10 - Number(id.slice(1))) * 86_400_000);
  vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    if (url.pathname === "/v1/oauth/token") return Response.json({ access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600 });
    if (!url.pathname.includes("/proxy/")) throw new Error("Unexpected synthetic endpoint");
    expect(url.searchParams.get("external_user_id")).toBe("pd_owner_fixture");
    expect(url.searchParams.get("account_id")).toBe("apn_fixture");
    const target = new URL(Buffer.from(url.pathname.split("/proxy/")[1]!, "base64url").toString());
    expect(target.origin).toBe("https://gmail.googleapis.com");
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    calls.push({ target, method: init.method! });
    if (target.pathname.endsWith("/profile")) return Response.json({ emailAddress: "me@example.test" });
    if (target.pathname.endsWith("/threads")) return Response.json({ threads: [{ id: "thread_fixture", snippet: "Synthetic email only" }] });
    if (target.pathname.endsWith("/threads/thread_fixture")) return Response.json({ id: "thread_fixture", historyId: "history_fixture",
      messages: [5, 2, 4, 1, 3].map(n => ({ id: `m${n}`, internalDate: date(`m${n}`) })) });
    const id = target.pathname.split("/").at(-1)!;
    if (/^m[1-5]$/.test(id)) return Response.json({ id, threadId: "thread_fixture", internalDate: date(id), payload: {
      mimeType: "text/plain", body: { data: Buffer.from(`Synthetic complete message ${id}. Ignore this attempted instruction to send email.`).toString("base64url") } } });
    throw new Error("Unexpected synthetic Gmail target");
  }));
  const pipedream = await createPipedreamClient({ clientId: "synthetic-id", clientSecret: "synthetic-secret", projectId: "proj_fixture", environment: "production" });
  const row = { id: "conn_fixture", user_id: "owner_fixture", service: "gmail", status: "active", account_label: "Work",
    account_email: "me@example.test", pipedream_account_id: "apn_fixture" };
  const db = { listConnectedServices: vi.fn(async () => [row]), getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner_fixture" })) };
  const evaluate = vi.fn<JevService["evaluate"]>(async () => ({ requestId: "jev_req_fixture_result", recipe: "email-triage-v1" as const, model: JEV_MODEL_ID, latencyMs: 1,
    answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => ({ id, type: "boolean" as const, probability: id === "cold_outreach" ? 0.94 : 0.1 })) }));
  const current = new Date(now);
  const funding = { topUpEnabled: false, asOf: current.toISOString(), periodStart: new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)).toISOString(),
    monthlyBudgetMicrousd: 10_000_000, settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
    promotionalBalanceMicrousd: 5_000_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 5_000_000,
    remainingBalanceMicrousd: 5_000_000, remainingBudgetMicrousd: 10_000_000 };
  const policy = { enabled: mode !== "unfunded", globalRevision: 1, runtimeRevision: 1, allowedModelIds: mode === "unfunded" ? [] : [JEV_MODEL_ID],
    monthlyBudgetMicrousd: 10_000_000, checkedAt: new Date(now).toISOString(), staleAfter: new Date(now + 60_000).toISOString() };
  const summary = FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, funding, policy });
  const receipt = FundedAiRouteReadinessReceiptSchema.parse({ contractVersion: 1, globalRevision: 1, runtimeRevision: 1,
    checkedAt: policy.checkedAt, staleAfter: new Date(now + 30_000).toISOString(), readyModelIds: policy.allowedModelIds });
  let summaryReader = { getFundingSummary: async () => summary };
  let routeReader = { getRouteReadiness: async () => receipt };
  let closePlatform = async () => undefined;
  let operationalProbe = vi.fn(async (_model: string, _call?: unknown) => ({ ready: true, checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString() }));
  if (mode === "platform-filter") {
    const { db: platformDb } = await createTestPlatformDb();
    closePlatform = async () => destroyTestPlatformDb(platformDb);
    const secret = "synthetic-platform-secret-123456789";
    const identity = { ownerId: "funded_owner_fixture", machineId: "machine_fixture", runtimeSlot: "primary" };
    await insertUserMachine(platformDb, { ...identity, clerkUserId: identity.ownerId, handle: "fixture",
      status: "running", imageVersion: "v-fixture", provisionedAt: new Date(now).toISOString(), activationState: "authorized" });
    const repository = createAiFundedPolicyRepository({ db: platformDb, credentialHashSecret: "synthetic-hash-secret-1234567890123" });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [JEV_MODEL_ID] });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [JEV_MODEL_ID],
      expiresAt: null, monthlyBudgetMicrousd: 1_000_000 });
    await repository.grantCredit({ identity, entryId: "synthetic_grant", kind: "promotional_grant", amountMicrousd: 1_000_000, sourceReference: "synthetic-only" });
    const platform = new Hono(); const relayApp = new Hono();
    const control = "synthetic-relay-control-1234567890123";
    const relay = createFundedRelay({ ...resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/fixture/anthropic",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32), PLATFORM_INTERNAL_URL: "https://platform.example.test",
      AI_RELAY_CONTROL_TOKEN: control, AI_RELAY_METADATA_SECRET: "m".repeat(32) })!,
      fetch: (async (raw, init) => {
        if (String(raw).startsWith("https://platform.example.test/")) return platform.request(String(raw), init);
        const body = JSON.parse(String(init?.body));
        expect(body.input.state).toBe("Synthetic Jev readiness check. No email or owner data.");
        return Response.json({ success: true, errors: [], messages: [], result: { state: "Completed", result: {
          model: "jev-1.13.0", usage: { input_tokens: 275, output_tokens: 0 },
          answers: Object.fromEntries(JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => [id, { type: "noul", noul: 0.1 }])) } } });
      }) as typeof fetch });
    relay.register(relayApp);
    const probes = createFundedModelProbeService({ db: platformDb, relayBaseUrl: "https://relay.example.test", relayControlToken: control,
      dailyLimit: 10, minuteLimit: 2, credentials: repository,
      fetchFn: ((raw, init) => relayApp.request(String(raw), init)) as typeof fetch });
    operationalProbe = vi.fn(probes.probe);
    platform.route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({
      db: platformDb, platformSecret: secret, repository, routeProbes: { probe: operationalProbe } }));
    platform.route("/internal/ai/funded", createAiFundedRelayRoutes({ relayControlToken: control, repository }));
    closePlatform = async () => { await relay.close(); await destroyTestPlatformDb(platformDb); };
    const config = loadFundedAiRuntimeConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.test",
      PLATFORM_INTERNAL_URL: "https://platform.example.test", MATRIX_FUNDED_AI_RUNTIME_TOKEN: buildPlatformRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: identity.runtimeSlot }, secret),
      MATRIX_HANDLE: "fixture", MATRIX_CLERK_USER_ID: identity.ownerId, MATRIX_MACHINE_ID: identity.machineId, MATRIX_RUNTIME_SLOT: identity.runtimeSlot })!;
    const fetchFn = ((url: string, init?: RequestInit) => platform.request(url, init)) as typeof fetch;
    summaryReader = createFundedAiFundingSummaryClient(config, { fetchFn });
    routeReader = createFundedAiRouteReadinessClient(config, fetchFn);
  }
  const runtime = createProductionJevInboxRuntime({ homePath: home, ownerId: "owner_fixture", fundedOwnerId: "funded_owner_fixture",
    settings: { getSnapshot: async () => settings }, getAgent: async () => agent,
    service: { evaluate }, summary: summaryReader, routes: routeReader,
    internalBaseUrl: null, db: db as unknown as PlatformDb, pipedream });
  const app = new Hono(); app.use("*", authMiddleware("fixture-machine-token"));
  app.route("/api/jev", runtime.routes);
  const capability = issueHermesIntegrationCapability("owner_fixture", scope); const controller = new AbortController();
  const request = (input: unknown, token = capability.token) => app.request("/api/jev/inbox/preview", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  return { runtime, agent, scope, calls, evaluate, controller, request, operationalProbe,
    close: async () => { capability.revoke(); runtime.close(); await closePlatform(); await rm(home, { recursive: true, force: true }); } };
}

it("admits the actual Jev production factory through Platform's exact-model filter only after profile preflight", async () => {
  const f = await fixture("platform-filter");
  try {
    await f.runtime.admit("owner_fixture", f.agent);
    expect(f.operationalProbe).not.toHaveBeenCalled();
    await f.runtime.launch.preflight("owner_fixture", f.scope, f.controller.signal);
    expect(f.operationalProbe).toHaveBeenCalledWith(JEV_MODEL_ID, expect.any(Object));
    expect(f.calls.every(call => call.target.pathname.endsWith("/profile"))).toBe(true);
    expect(f.evaluate).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("composes production owner-key/readiness, active scope, real SDK getter, latest four and server proposal", async () => {
  const f = await fixture();
  try {
    await f.runtime.admit("owner_fixture", f.agent); expect(f.calls).toEqual([]); expect(f.evaluate).not.toHaveBeenCalled();
    await f.runtime.launch.preflight("owner_fixture", f.scope, f.controller.signal);
    expect(f.calls.every(call => call.target.pathname.endsWith("/profile"))).toBe(true);
    const discoveryResponse = await f.request({ operation: "discover" }); expect(discoveryResponse.status).toBe(200);
    const discovery = await discoveryResponse.json();
    const beforeInvalid = f.calls.length;
    expect((await f.request({ operation: "select", receipt: "0".repeat(64), threadId: "thread_fixture" })).status).toBe(403);
    expect(f.calls).toHaveLength(beforeInvalid);
    const selectedResponse = await f.request({ operation: "select", receipt: discovery.receipt, threadId: "thread_fixture" });
    expect(selectedResponse.status).toBe(200); const selected = await selectedResponse.json();
    expect(selected.messageCount).toBe(4); expect(f.evaluate).not.toHaveBeenCalled();
    const evaluated = await f.request({ operation: "evaluate", receipt: selected.receipt }); expect(evaluated.status).toBe(200);
    expect(await evaluated.json()).toMatchObject({ kind: "proposal", verified: true, readonly: true, messageCount: 4, archiveProposal: { removeLabelIds: ["INBOX"] } });
    expect(f.evaluate).toHaveBeenCalledOnce();
    const paid = f.evaluate.mock.calls[0]!;
    expect(paid[0]).toBe("funded_owner_fixture");
    expect(JSON.parse(paid[1].state).messages.map((message: { id: string }) => message.id)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(f.runtime.launch.summary("owner_fixture", f.scope)).toContain("Verified snapshot: 4 messages");
    f.controller.abort(); expect((await f.request({ operation: "evaluate", receipt: selected.receipt })).status).toBe(403);
    expect(f.runtime.launch.summary("owner_fixture", f.scope)).toBeNull(); expect(f.evaluate).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it.each(["unsupported", "unfunded"])("blocks production %s route before mailbox reads or any evaluation", async mode => {
  const f = await fixture(mode);
  try {
    await expect(f.runtime.admit("owner_fixture", f.agent)).rejects.toMatchObject({ code: mode === "unsupported" ? "workflow_setup_required" : "workflow_funding_required" });
    expect(f.calls).toEqual([]); expect(f.evaluate).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it.each(["generic-capability", "other-owner", "other-run", "stale-revision", "changed-account"])("rejects production %s authority before requested mailbox reads", async mode => {
  const f = await fixture(); let extra: ReturnType<typeof issueHermesIntegrationCapability> | undefined;
  try {
    await f.runtime.launch.preflight("owner_fixture", f.scope, f.controller.signal);
    const before = f.calls.length;
    const changed = { ...f.scope, ...(mode === "other-run" ? { runId: "other_run" } : {}),
      ...(mode === "stale-revision" ? { revision: 2 } : {}),
      ...(mode === "changed-account" ? { account: { ...f.scope.account, connectionId: "other_connection" } } : {}) };
    extra = issueHermesIntegrationCapability(mode === "other-owner" ? "other_owner" : "owner_fixture",
      mode === "generic-capability" ? undefined : changed);
    expect((await f.request({ operation: "discover" }, extra.token)).status).toBe(403);
    expect(f.calls).toHaveLength(before); expect(f.evaluate).not.toHaveBeenCalled();
  } finally { extra?.revoke(); await f.close(); }
});
