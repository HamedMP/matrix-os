/** HTTP -> real durable service/database; no timer, runtime, account or model starts. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createBotRoutineRoutes } from "../../../packages/gateway/src/bots/routine-routes.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let data: Awaited<ReturnType<typeof createBotStateDatabase>>;
let service: ReturnType<typeof createBotRoutineExecution>;
let repo: ReturnType<typeof createBotRoutinesRepository>;
const CHAT = "chat_routine_http";
beforeAll(async () => {
  data = await createBotStateDatabase();
  await insertChat(data.db, CHAT);
  await createBotBindingsRepository(data.db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  const transact = createBotStateTransactions(new ChatRepository(data.db as unknown as Kysely<ChatDatabase>));
  // Real missing-authority path. No synthetic grant/approval is created by this test.
  const approvals = createBotRoutineApprovals({ db: data.db, transact, definitionRevision: async () => 1 });
  repo = createBotRoutinesRepository(data.db);
  service = createBotRoutineExecution({ db: data.db, transact, approvals, now: () => new Date(NOW) });
});
afterAll(async () => { await service?.stop(); await data?.destroy(); });
const app = (userId = OWNER) => createBotRoutineRoutes({ routines: service, getPrincipal: () => ({ userId, source: "jwt" }) });
const path = (id: string) => `/api/chat-agents/${BOT}/routines/${id}/control`;
const post = (status: string, baseRevision: number) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, baseRevision }) });
async function seed() {
  // Internal synthetic row deliberately lacks authorization; never starts scheduling.
  return repo.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW, nextFireAt: "2026-09-27T12:01:00.000Z",
    proposal: { name: "HTTP synthetic", prompt: "Read synthetic text only", schedule: { kind: "interval", everyMs: 60000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "synthetic" }, authorizedEffects: ["read"] } });
}
it("persists HTTP pause/archive and rejects stale revisions without changing state", async () => {
  const row = await seed(), owner = app();
  const pause = await owner.request(path(row.routineId), post("paused", row.revision));
  expect(pause.status).toBe(200);
  expect(await pause.json()).toEqual({ routineId: row.routineId, status: "paused", revision: 2 });
  expect(pause.headers.get("cache-control")).toBe("private, no-store");
  expect((await owner.request(path(row.routineId), post("archived", 1))).status).toBe(409);
  const list = await (await owner.request(`/api/chat-agents/${BOT}/routines`)).json();
  expect(list.routines.find((r: { routineId: string }) => r.routineId === row.routineId)).toMatchObject({ status: "paused", revision: 2 });
  expect((await repo.get(OWNER, row.routineId))?.revision).toBe(2);
  expect((await owner.request(path(row.routineId), post("archived", 2))).status).toBe(200);
  expect((await repo.get(OWNER, row.routineId))?.status).toBe("archived");
});
it("rejects known foreign routine IDs at the HTTP service/database boundary", async () => {
  const row = await seed(), foreign = app("foreign_owner");
  expect(await (await foreign.request(`/api/chat-agents/${BOT}/routines`)).json()).toEqual({ routines: [] });
  expect((await foreign.request(path(row.routineId), post("archived", 1))).status).toBe(404);
  expect(await repo.get(OWNER, row.routineId)).toMatchObject({ status: "active", revision: 1 });
});
it("refuses HTTP resume without standing approval and preserves paused state", async () => {
  const row = await seed(), owner = app();
  expect((await owner.request(path(row.routineId), post("paused", 1))).status).toBe(200);
  const resume = await owner.request(path(row.routineId), post("active", 2));
  expect(resume.status).toBe(400);
  expect(await resume.json()).toEqual({ code: "invalid_request", message: "The request is invalid." });
  expect(await repo.get(OWNER, row.routineId)).toMatchObject({ status: "paused", revision: 2, authorization: null });
});
