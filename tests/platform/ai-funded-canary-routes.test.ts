import { Hono } from "hono";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUNDED_AI_CANARY_ROUTING_HEADER, FUNDED_AI_READINESS_CATALOG } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { reserveFundedModelProbe, type FundedModelProbeCall } from "../../packages/platform/src/ai-funded-model-probes.js";
import { migrateFundedProbeCache } from "../../packages/platform/src/database/funded-probe-cache-migration.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const platformSecret = "canary-platform-secret-for-tests-long";
const start = "2026-11-16T08:00:00.000Z";
const expiresAt = "2026-11-16T08:00:10.000Z";
const fullGlm = "@cf/zai-org/glm-5.3";
const deepSeek = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const candidate = {
  identity: { ownerId: "user_operator", machineId: "test-machine", runtimeSlot: "primary" },
  runtimeTokenEpoch: 1,
  expiresAt,
  relayOrigin: "https://relay-22ed178caaca---matrix-ai-relay-production-abcdefghij-ey.a.run.app",
};
const customer = { ownerId: "user_customer", machineId: "customer-machine", runtimeSlot: "primary" };

describe("production canary route", () => {
  let db: PlatformDB;
  let clock: Date;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(start);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  async function setup() {
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "funded-hash-secret-for-fixtures-only", now: () => clock, canaryBinding: candidate });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [fullGlm] });
    for (const [handle, identity] of [["operator", candidate.identity], ["customer", customer]] as const) {
      await insertUserMachine(db, {
        machineId: identity.machineId, clerkUserId: identity.ownerId, handle, runtimeSlot: identity.runtimeSlot,
        status: "running", imageVersion: "test", provisionedAt: start, activationState: "authorized",
      });
      await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
        allowedModelIds: [fullGlm, deepSeek], monthlyBudgetMicrousd: 25_000, expiresAt: null });
      await repository.grantCredit({ entryId: `grant-${handle}`, kind: "addon_grant", amountMicrousd: 25_000,
        identity, sourceReference: `canary-fixture-${handle}` });
    }
    const result = { ready: true, checkedAt: start, staleAfter: "2026-11-16T08:00:30.000Z" };
    const incumbent = vi.fn(async () => result);
    const canary = vi.fn(async (_model: string, _call?: FundedModelProbeCall) => result);
    const app = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({
      db, platformSecret, repository, now: () => clock, routeProbes: { probe: incumbent },
      canary: { binding: candidate, routeProbes: { probe: canary } },
    }));
    return { app, incumbent, canary };
  }

  function request(app: Hono, handle: "operator" | "customer", path: string, headers = {}, body = "{}") {
    const { machineId, runtimeSlot } = handle === "operator" ? candidate.identity : customer;
    const token = buildPlatformRuntimeVerificationToken({ handle, machineId, runtimeSlot }, platformSecret);
    return app.request(`/internal/containers/${handle}/ai/${path}?runtimeSlot=${runtimeSlot}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body,
    });
  }

  it("negotiates the candidate only for the authenticated test runtime", async () => {
    const { app } = await setup();
    const header = { [FUNDED_AI_CANARY_ROUTING_HEADER]: "1" };
    const modern = await request(app, "operator", "funded-credential", header);
    expect(modern.status).toBe(200);
    expect(await modern.json()).toMatchObject({ relayRoute: { origin: candidate.relayOrigin, expiresAt } });
    const legacy = await request(app, "operator", "funded-credential", {}, '{"requestClass":"background"}');
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).not.toHaveProperty("relayRoute");
    const other = await request(app, "customer", "funded-credential", header);
    expect(other.status).toBe(200);
    expect(await other.json()).not.toHaveProperty("relayRoute");
  });

  it("uses separate readiness and resumes incumbent probes when the binding expires", async () => {
    const { app, incumbent, canary } = await setup();
    const headers = { [FUNDED_AI_READINESS_CATALOG.header]: FUNDED_AI_READINESS_CATALOG.version };
    const a = await request(app, "operator", "route-readiness", headers);
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ readyModelIds: expect.arrayContaining([fullGlm, deepSeek]), staleAfter: expiresAt });
    expect(canary.mock.calls.length).toBe(2);
    expect(incumbent).not.toHaveBeenCalled();
    const b = await request(app, "customer", "route-readiness", headers);
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ readyModelIds: [fullGlm] });
    expect(incumbent).toHaveBeenCalledTimes(1);
    clock = new Date(expiresAt);
    const c = await request(app, "operator", "route-readiness", headers);
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ readyModelIds: [fullGlm] });
    expect(canary).toHaveBeenCalledTimes(2);
    expect(incumbent).toHaveBeenCalledTimes(2);
  });

  it("cancels candidate probe work at the binding cutoff and ignores evidence returned afterward", async () => {
    const { app, canary } = await setup();
    const stopped: boolean[] = [];
    const expiresMs = Date.parse(expiresAt);
    clock = new Date(expiresMs - 40);
    canary.mockImplementation(async (_model, call) => {
      const signal = call?.signal;
      stopped.push(await new Promise<boolean>((resolve) => {
        if (signal?.aborted) { resolve(true); return; }
        const onAbort = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, 250);
        signal?.addEventListener("abort", onAbort, { once: true });
      }));
      clock = new Date(expiresMs);
      return { ready: true, checkedAt: start, staleAfter: "2026-11-16T08:00:30.000Z" };
    });
    const headers = { [FUNDED_AI_READINESS_CATALOG.header]: FUNDED_AI_READINESS_CATALOG.version };
    const response = await request(app, "operator", "route-readiness", headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ readyModelIds: [] });
    expect(stopped).toEqual([true, true]);
  });

  it("preserves the incumbent allowance through migration and tracks candidate probes separately", async () => {
    const config = { db, now: clock, dailyLimit: 1, minuteLimit: 1 };
    await sql`alter table ai_funded_model_probe_budget
      drop constraint ai_funded_model_probe_budget_budget_key_check,
      add constraint ai_funded_model_probe_budget_budget_key_check check (budget_key = 'global')`.execute(db.executor);
    expect(await reserveFundedModelProbe(config)).toBe(true);
    await migrateFundedProbeCache(db.executor);
    expect(await reserveFundedModelProbe({ ...config, budgetKey: "canary" })).toBe(true);
    expect(await reserveFundedModelProbe({ ...config, budgetKey: "canary" })).toBe(false);
    expect(await reserveFundedModelProbe(config)).toBe(false);
  });
});
