import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as contracts from "../../../packages/contracts/src/bots/index.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { NOW, OWNER, OTHER_OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { invocation } from "./routine-cli-source-support.js";
import { requestFixture, insertRoutine, insertFire, TARGET_A, TARGET_B, scope, proposal } from "./routine-cli-request-support.js";
let fixture: Awaited<ReturnType<typeof requestFixture>>, destroy: () => Promise<void>;
beforeEach(async () => { const state = await createBotStateDatabase(); destroy = state.destroy; fixture = await requestFixture(state.db); });
afterEach(async () => { try { await fixture?.close(); } finally { await destroy?.(); } });
const historicalChat = async () => {
  await insertChat(fixture.db, "chat_other_history");
  await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: TARGET_A.botId, chat_id: "chat_other_history", kind: "direct", created_at: NOW, removed_at: at(1) }).execute();
  return "chat_other_history";
};
describe("source-only safe routine views backed by actual canonical repository rows", () => {
  it("projects only safe observed state, never raw authorization or fire identities", async () => {
    const id = await insertRoutine(fixture.db, 1); await insertFire(fixture.db, id, 1);
    const listed = await fixture.execute({ operation: "list" });
    expect(listed).toMatchObject({ kind: "list", truncated: false, routines: [{ routineId: id, name: "Daily report", status: "active", revision: 1, requiresReview: true, lastFire: { status: "uncertain", scheduledFor: at(1), updatedAt: at(1) } }] });
    expect(contracts.RoutineCliResultSchema.safeParse(listed).success).toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(/private|ownerId|computerId|botId|chatId|taskId|runId|fireId|accountId|approvalId|grantRevision|failureCode/);
    expect(contracts.RoutineCliResultSchema.safeParse({ ...listed, ownerId: OWNER }).success).toBe(false);
  });
  it("filters target Chat before LIMIT so another Chat's archived history cannot hide an eligible row", async () => {
    const chatId = await historicalChat();
    for (let n = 1; n <= 33; n++) await insertRoutine(fixture.db, n, { chatId, status: "archived", createdAt: at(n) });
    const id = await insertRoutine(fixture.db, 99, { status: "archived" });
    expect(await fixture.execute({ operation: "list" })).toMatchObject({ routines: [{ routineId: id }], truncated: false });
  });
  it("reports truncated retained history while show reads archived records directly by ID", async () => {
    const id = await insertRoutine(fixture.db, 1, { status: "archived" });
    for (let n = 2; n <= 34; n++) await insertRoutine(fixture.db, n, { status: "archived", createdAt: at(n) });
    const listed = await fixture.execute({ operation: "list" });
    expect(listed).toMatchObject({ truncated: true });
    if (listed.kind !== "list") throw new Error("Expected list");
    expect(listed.routines).toHaveLength(32); expect(listed.routines.some(row => row.routineId === id)).toBe(false);
    expect(await fixture.execute({ operation: "show", routineId: id })).toMatchObject({ kind: "show", routine: { routineId: id, status: "archived" }, history: { fires: [], truncated: false } });
  });
  it.each(["same Bot different Chat", "different Bot same owner", "foreign owner"])("rejects %s for show and control", async fault => {
    let id: string;
    if (fault === "same Bot different Chat") id = await insertRoutine(fixture.db, 1, { chatId: await historicalChat() });
    else if (fault === "different Bot same owner") id = await insertRoutine(fixture.db, 1, TARGET_B);
    else {
      const chatId = "chat_foreign"; await insertChat(fixture.db, chatId, OTHER_OWNER);
      await createBotBindingsRepository(fixture.db).bindDirect({ ownerId: OTHER_OWNER, botId: TARGET_A.botId, chatId, now: NOW });
      id = "rt_" + "f".repeat(24);
      await fixture.db.insertInto("bot_routines").values({ routine_id: id, owner_id: OTHER_OWNER, bot_id: TARGET_A.botId, chat_id: chatId,
        proposal, approved_source: null, approval_id: null, status: "active", next_fire_at: at(60_000), revision: 1, created_at: NOW, updated_at: NOW }).execute();
    }
    await expect(fixture.execute({ operation: "show", routineId: id })).rejects.toMatchObject({ code: "not_found" });
    await expect(fixture.execute({ operation: "pause", routineId: id, baseRevision: 1, requestId: invocation(100) })).rejects.toMatchObject({ code: "not_found" });
    expect(await fixture.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
  });
  it.each([{ ...scope, computerId: "computer_other" }, { ...scope, ownerId: OTHER_OWNER }])("rejects a foreign configured scope before returning any rows", async foreignScope => {
    await insertRoutine(fixture.db, 1);
    await expect(fixture.execute({ operation: "list" }, { scope: foreignScope })).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("keeps older uncertain fires visible as review state beyond bounded safe history", async () => {
    const id = await insertRoutine(fixture.db, 1);
    await insertFire(fixture.db, id, 1);
    for (let n = 2; n <= 22; n++) await insertFire(fixture.db, id, n, "completed");
    const result = await fixture.execute({ operation: "show", routineId: id });
    expect(result).toMatchObject({ routine: { requiresReview: true, lastFire: { status: "completed" } }, history: { truncated: true } });
    if (result.kind !== "show") throw new Error("Expected show");
    expect(result.history.fires).toHaveLength(20);
    expect(result.history.fires.every(row => row.status === "completed")).toBe(true);
    expect(contracts.RoutineCliResultSchema.safeParse(result).success).toBe(true);
  });
});
