import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiCreditHistoryHandler } from "../../packages/platform/src/billing/ai-credit-history-route.js";
import { createBillingRoutes, type StripeBillingClient } from "../../packages/platform/src/billing-routes.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

describe("Matrix AI credit history", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    for (const [owner, machine, slot] of [["alice", "computer-a", "primary"], ["alice", "computer-preview", "preview"], ["bob", "computer-b", "primary"]]) {
      await insertUserMachine(db, { machineId: machine!, clerkUserId: owner!, runtimeSlot: slot!, handle: machine!, status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: "2026-10-01T00:00:00.000Z" });
    }
    await db.executor.insertInto("ai_runtime_credentials").values({
      token_id: "history-token", owner_id: "alice", machine_id: "computer-a", runtime_slot: "primary",
      token_hash: "a".repeat(64), audience: "matrix-funded-relay", scope: "ai:invoke", issued_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-10-02T00:00:00.000Z", revoked_at: null,
    }).execute();
    await db.executor.insertInto("ai_funded_usage_reservations").values({
      reservation_id: "private-reservation", request_id: "private-request", payload_hash: "a".repeat(64), authorization_response: "{}",
      settlement_response: "{}", finalization_mode: null, manual_review_evidence_ref: null, manual_review_actor: null, manual_reviewed_at: null,
      start_response: "{}", release_response: null, release_reason: null, token_id: "history-token", owner_id: "alice", machine_id: "computer-a", runtime_slot: "primary",
      model_id: "anthropic/claude-sonnet-5", reserved_microusd: 500, promotional_reserved_microusd: null, addon_reserved_microusd: null,
      actual_microusd: 500, resolved_model: null, pricing_version: null, period_start: "2026-10-01T00:00:00.000Z", status: "settled",
      created_at: "2026-10-01T00:00:00.000Z", started_at: null, expires_at: "2026-10-02T00:00:00.000Z", settled_at: "2026-10-01T01:00:00.000Z", released_at: null,
    }).execute();
    await db.executor.insertInto("ai_funded_credit_ledger").values([
      ["private-entry-a", "alice", "computer-a", "primary", "addon_grant", 5_000_000],
      ["private-entry-b", "alice", "computer-a", "primary", "addon_debit", -500],
      ["private-preview", "alice", "computer-preview", "preview", "promotional_grant", 99],
      ["private-bob", "bob", "computer-b", "primary", "addon_grant", 88],
    ].map(([entry, owner, machine, slot, kind, amount]) => ({ entry_id: String(entry), owner_id: String(owner), machine_id: String(machine), runtime_slot: String(slot), kind: String(kind), amount_microusd: Number(amount), source_reference: "secret-source-reference", reservation_id: kind === "addon_debit" ? "private-reservation" : null, period_start: kind === "addon_debit" ? "2026-10-01T00:00:00.000Z" : null, expires_at: null, created_at: "2026-10-01T01:00:00.000Z" }))).execute();
  });
  afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
  function app(owner: string | null = "alice") {
    const app = new Hono();
    app.get("/history", createAiCreditHistoryHandler({ db, resolveClerkUserId: async () => owner }));
    return app;
  }
  it("uses authenticated owner/current computer only and projects no private identifiers", async () => {
    const response = await app().request("/history");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toMatch(/private-|secret-source|computer-|alice|bob|reservation/);
    expect(JSON.parse(text)).toEqual({ entries: [
      { occurredAt: "2026-10-01T01:00:00.000Z", kind: "usage", amountMicrousd: -500, modelId: "anthropic/claude-sonnet-5" },
      { occurredAt: "2026-10-01T01:00:00.000Z", kind: "credit", amountMicrousd: 5_000_000, modelId: null },
    ], nextCursor: null });
  });
  it("prevents browser and CDN caching for owner history and every error response", async () => {
    const withVary = new Hono();
    withVary.use("*", async (c, next) => { c.header("Vary", "Accept"); await next(); });
    withVary.get("/history", createAiCreditHistoryHandler({ db, resolveClerkUserId: async () => "alice" }));
    const responses = [
      await withVary.request("/history"),
      await app(null).request("/history"),
      await app().request("/history?limit=0"),
      await app().request("/history?runtimeSlot=missing"),
    ];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.executor, "selectFrom").mockImplementation(() => { throw new Error("database unavailable"); });
    responses.push(await app().request("/history"));
    expect(responses.map(response => response.status)).toEqual([200, 401, 400, 409, 503]);
    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("Vary")).toContain("Authorization");
    }
    expect(responses[0].headers.get("Vary")).toContain("Accept");
    log.mockRestore();
  });
  it("keyset paginates equal timestamps without duplicates and rejects cross-runtime/owner markers", async () => {
    const first = await (await app().request("/history?limit=1")).json();
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^[a-f0-9]{32}$/);
    const second = await (await app().request(`/history?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.entries[0].kind).toBe("credit");
    expect(second.nextCursor).toBeNull();
    expect((await app().request(`/history?runtimeSlot=preview&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await app("bob").request(`/history?cursor=${first.nextCursor}`)).status).toBe(400);
  });
  it("keeps model unknown when reservation scope differs or settlement is unfinished", async () => {
    await db.executor.updateTable("ai_funded_usage_reservations").set({ owner_id: "bob" }).where("reservation_id", "=", "private-reservation").execute();
    expect((await (await app().request("/history")).json()).entries[0].modelId).toBeNull();
    await db.executor.updateTable("ai_funded_usage_reservations").set({ owner_id: "alice", status: "in_flight" }).where("reservation_id", "=", "private-reservation").execute();
    expect((await (await app().request("/history")).json()).entries[0].modelId).toBeNull();
  });
  it("returns settled Cloudflare GLM usage alongside the scoped credit ledger", async () => {
    await db.executor.updateTable("ai_funded_usage_reservations")
      .set({ model_id: "@cf/zai-org/glm-5.3-flash", resolved_model: "@cf/zai-org/glm-5.3-flash", actual_microusd: 111 })
      .where("reservation_id", "=", "private-reservation").execute();
    await db.executor.updateTable("ai_funded_credit_ledger").set({ amount_microusd: -111 })
      .where("entry_id", "=", "private-entry-b").execute();
    const response = await app().request("/history");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: [
      { kind: "usage", amountMicrousd: -111, modelId: "@cf/zai-org/glm-5.3-flash" },
      { kind: "credit", modelId: null },
    ], nextCursor: null });
  });
  it("returns a truthful empty page for a computer without ledger entries", async () => {
    await db.executor.deleteFrom("ai_funded_credit_ledger").where("machine_id", "=", "computer-a").execute();
    expect(await (await app().request("/history")).json()).toEqual({ entries: [], nextCursor: null });
  });
  it.each(["limit=0", "limit=51", "limit=1.5", "limit=1e1", "cursor=secret", "cursor=" + "a".repeat(32), "ownerId=bob", "machineId=computer-b", "runtimeSlot=../primary", "limit=1&limit=2"])("rejects invalid query %s", async (query) => {
    expect((await app().request(`/history?${query}`)).status).toBe(400);
  });
  it("requires authentication and active authorized computer", async () => {
    expect((await app(null).request("/history")).status).toBe(401);
    expect((await app().request("/history?runtimeSlot=missing")).status).toBe(409);
    await db.executor.updateTable("user_machines").set({ activation_state: "awaiting_billing" }).where("machine_id", "=", "computer-a").execute();
    expect((await app().request("/history")).status).toBe(409);
  });
  it("maps failed database reads to generic errors without private details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.executor, "selectFrom").mockImplementation(() => { throw new Error("postgres://private-secret"); });
    const response = await app().request("/history");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"History is unavailable"}');
    log.mockRestore();
  });
  it("registers the authenticated billing history route", async () => {
    const stripe = { apiTimeoutMs: 10_000 } as StripeBillingClient;
    const app = new Hono().route("/billing", createBillingRoutes({ db, stripe, env: {}, resolveClerkUserId: async () => "alice" }));
    expect((await app.request("/billing/ai-credit/history")).status).toBe(200);
  });
});
