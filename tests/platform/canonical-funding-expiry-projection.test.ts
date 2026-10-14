import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { IsolatedChatEnvelope } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createCanonicalPhaseReadiness } from "../../packages/gateway/src/chat/canonical-phase-readiness.js";
import * as waivers from "../../packages/platform/src/ai-funded-usage-waiver-admission.js";
import { ensureSpeechMonthlyAllowance } from "../../packages/platform/src/speech/allowance.js";
import { createCanonicalPlatformTestDb } from "./canonical-phase-postgres.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const identity = { ownerId: "expiry_owner", machineId: "expiry_machine", runtimeSlot: "primary" };
const modelId = "@cf/zai-org/glm-5.3-flash";
const starts = new Date("2026-09-30T23:59:00.000Z");
const expiry = "2026-10-01T00:00:00.000Z";

async function fixture() {
  const { db, close } = await createCanonicalPlatformTestDb(); cleanup.push(close);
  let clock = starts;
  const secret = "expiry-platform-secret".repeat(2);
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "expiry",
    runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "fixture", activationState: "authorized", provisionedAt: starts.toISOString() });
  const token = buildPlatformRuntimeVerificationToken({ handle: "expiry", ...identity }, secret);
  const phase: IsolatedChatEnvelope = { ...identity, phaseId: "phase_expiry", chatId: "chat_expiry", modelId,
    runtimeTokenEpoch: 1, runtimeCredentialSha256: createHash("sha256").update(token).digest("hex"), sourceSha: "a".repeat(40),
    target: { kind: "canonical_bot", botId: "bot_expiry01", recipeRef: { recipeId: "matrix-bot", version: "1.0.0" } },
    startsAt: starts.toISOString(), expiresAt: "2026-10-01T00:14:00.000Z" };
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(43), now: () => clock });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
  await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1000, expiresAt: null });
  const platform = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db, repository,
    platformSecret: secret, isolatedChat: phase, now: () => clock }));
  const scope = createCanonicalPhaseReadiness(phase, { identity: () => ({ ...identity, runtimeTokenEpoch: 1,
    credentialSha256: phase.runtimeCredentialSha256, sourceSha: phase.sourceSha }), now: () => clock });
  const url = "https://platform.test/internal/containers/expiry/ai/funding-summary?runtimeSlot=primary";
  const read = (chat: boolean) => platform.request(url, { method: "POST", body: JSON.stringify(chat ? { includeChatAvailability: true } : {}),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...scope.requestHeaders({ identity, runtimeAuthToken: token }) } });
  const grant = (entryId: string, amountMicrousd: number, expiresAt?: string, kind: "promotional_grant" | "addon_grant" = "promotional_grant") =>
    repository.grantCredit({ identity, entryId, amountMicrousd, kind, sourceReference: "expiry-fixture", ...(expiresAt ? { expiresAt } : {}) });
  const finances = async () => ({
    balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().orderBy("machine_id").execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().orderBy("grant_entry_id").execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().orderBy("entry_id").execute(),
    reservations: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().orderBy("grant_entry_id").execute(),
  });
  return { db, repository, read, grant, finances, setClock: (at: string) => { clock = new Date(at); } };
}

it.each([false, true])("canonical funding projects exact expiry without financial writes (Chat availability=%s)", async chat => {
  const f = await fixture(); await f.grant("expiring", 100, expiry);
  f.setClock("2026-09-30T23:59:59.999Z");
  expect((await (await f.read(chat)).json()).funding.creditBalanceMicrousd).toBe(100);
  f.setClock(expiry); const before = await f.finances();
  const response = await f.read(chat); expect(response.status).toBe(200);
  const projected = await response.json();
  expect(projected.funding).toMatchObject({ creditBalanceMicrousd: 0, promotionalBalanceMicrousd: 0, remainingBalanceMicrousd: 0 });
  expect(await f.finances()).toEqual(before);
  const reconciled = await f.repository.getRuntimeFundingSummary(identity, chat ? { includeChatAvailability: true } : {});
  expect(projected.funding).toEqual({ ...reconciled.funding, topUpEnabled: false });
  expect((await (await f.read(chat)).json()).funding).toEqual(projected.funding);
});

it("protects attributed active holds, preserves add-ons, projects rollover, and matches ordinary reconciliation", async () => {
  const f = await fixture(); await f.grant("protected", 100, expiry);
  const credential = (await f.repository.issueRuntimeCredential(identity)).credential;
  await f.repository.authorize({ credential: credential.token, requestId: "held", modelId, maxCostMicrousd: 70 });
  await f.grant("unprotected", 50, expiry);
  await f.grant("live", 200); await f.grant("addon", 80, undefined, "addon_grant");
  f.setClock(expiry); const before = await f.finances();
  const response = await f.read(true); expect(response.status).toBe(200); const projected = await response.json();
  expect(projected.funding).toMatchObject({ creditBalanceMicrousd: 350, promotionalBalanceMicrousd: 270,
    addonBalanceMicrousd: 80, reservedMicrousd: 70, remainingBalanceMicrousd: 280,
    periodStart: expiry, reservedThisMonthMicrousd: 0 });
  expect(projected.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 280, availableBalanceMicrousd: 280 });
  expect(await f.finances()).toEqual(before);
  const reconciled = await f.repository.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
  expect(projected.funding).toEqual({ ...reconciled.funding, topUpEnabled: false });
  expect(projected.chatAvailability).toEqual(reconciled.chatAvailability);
  expect((await f.finances()).reservations).toEqual(before.reservations);
});

it("projects expired speech and general grants while excluding unrelated runtime identities", async () => {
  const f = await fixture();
  await f.db.transaction(trx => ensureSpeechMonthlyAllowance(trx.executor, identity, {
    monthlyBudgetMicrousd: 1000, monthlyPromotionalCreditMicrousd: 50, now: starts }));
  await f.grant("general", 30, expiry);
  const foreign = { ownerId: "foreign_expiry_owner", machineId: "foreign_expiry_machine", runtimeSlot: "secondary" };
  await insertUserMachine(f.db, { machineId: foreign.machineId, clerkUserId: foreign.ownerId, handle: "foreign-expiry",
    runtimeSlot: foreign.runtimeSlot, status: "running", imageVersion: "fixture", activationState: "authorized", provisionedAt: starts.toISOString() });
  await f.repository.setRuntimePolicy({ identity: foreign, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1000, expiresAt: null });
  await f.repository.grantCredit({ identity: foreign, entryId: "foreign_expired", amountMicrousd: 1000, kind: "promotional_grant", sourceReference: "fixture", expiresAt: expiry });
  f.setClock(expiry); const before = await f.finances();
  const response = await f.read(false); expect(response.status).toBe(200);
  expect((await response.json()).funding.creditBalanceMicrousd).toBe(0); expect(await f.finances()).toEqual(before);
});

it("rejects corrupt protection rather than debit a protected grant or mutate finances", async () => {
  const f = await fixture(); await f.grant("protected", 100, expiry);
  const credential = (await f.repository.issueRuntimeCredential(identity)).credential;
  await f.repository.authorize({ credential: credential.token, requestId: "held", modelId, maxCostMicrousd: 70 });
  await f.db.executor.updateTable("ai_funded_reservation_promotional_allocations").set({ amount_microusd: 101 }).execute();
  f.setClock(expiry); const before = await f.finances();
  expect((await f.read(false)).status).toBe(503); expect(await f.finances()).toEqual(before);
});

it.each(["negative_balance", "unsafe_total", "grant_cap"])("canonical expiry projection fails closed on %s", async kind => {
  const f = await fixture(); await f.grant("expiring", 100, expiry);
  if (kind === "negative_balance") await f.db.executor.updateTable("ai_funded_runtime_balances").set({ promotional_balance_microusd: 99 }).execute();
  if (kind === "unsafe_total") await sql`update ai_funded_promotional_grant_balances set remaining_microusd = 9007199254740992`.execute(f.db.executor);
  if (kind === "grant_cap") {
    const row = await f.db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().executeTakeFirstOrThrow();
    const ledger = await f.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().executeTakeFirstOrThrow();
    await f.db.transaction(async trx => {
      await trx.executor.insertInto("ai_funded_credit_ledger").values(Array.from({ length: 64 }, (_, i) => ({ ...ledger, entry_id: `overflow_${i}` }))).execute();
      await trx.executor.insertInto("ai_funded_promotional_grant_balances").values(Array.from({ length: 64 }, (_, i) => ({ ...row, grant_entry_id: `overflow_${i}` }))).execute();
    });
  }
  f.setClock(expiry); const before = await f.finances();
  expect((await f.read(false)).status).toBe(503); expect(await f.finances()).toEqual(before);
});

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL).each([false, true])("actual PostgreSQL forbids canonical writes for either summary payload (Chat=%s)", async chat => {
  const f = await fixture(); await f.grant("expiring", 100, expiry); f.setClock(expiry);
  const before = await f.finances(); let code: unknown;
  vi.spyOn(waivers, "readUnknownUsageWaivers").mockImplementation(async executor => {
    try { await executor.updateTable("ai_funded_runtime_balances").set({ credit_balance_microusd: 999 }).execute(); }
    catch (error) { code = (error as { code?: string }).code; throw error; }
    throw new Error("Read-only enforcement missing");
  });
  expect((await f.read(chat)).status).toBe(503); expect(code).toBe("25006"); expect(await f.finances()).toEqual(before);
});
