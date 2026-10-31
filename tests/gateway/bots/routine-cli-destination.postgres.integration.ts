import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sql } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../../packages/gateway/src/request-principal.js";
import { createRoutineCliDestinationRoutes } from "../../../packages/gateway/src/bots/routine-cli-destination-routes.js";
import { createRoutineCliTargetService } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { createRoutineCliDestinationService } from "../../../packages/gateway/src/bots/routine-cli-destination-service.js";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { requestFixture, TARGET_A, TARGET_B, scope } from "./routine-cli-request-support.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof requestFixture>>, services: BotServices | undefined;
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL required for owner destination transactions/startup");
  data = await createRealBotStateDatabase(url); f = await requestFixture(data.db);
  vi.stubEnv("MATRIX_USER_ID", OWNER); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-owner-token");
});
afterEach(async () => { vi.unstubAllEnvs(); try { await services?.close(); await f?.close(); } finally { services = undefined; await data?.destroy(); } });
function app(targets: Parameters<typeof createRoutineCliDestinationRoutes>[0]["targets"]) {
  const application = new Hono(); application.use("*", authMiddleware("fixture-owner-token"));
  application.route("/", createRoutineCliDestinationRoutes({ targets, getPrincipal: requireRequestPrincipal })); return application;
}
const call = async (application: Hono, body?: unknown) => application.request("/api/routine-cli/destination", { method: body ? "POST" : "GET",
  headers: { authorization: "Bearer fixture-owner-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
it("actual Bot startup exposes owner+Computer destination service even without a runnable host and creates no grants/approvals", async () => {
  services = await startBots({ homePath: f.home, repository: f.chats, agents: f.agents, runtimeOwnerId: OWNER, computerId: scope.computerId,
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() } });
  expect(services?.routineDestination).toBeTruthy();
  const result = await call(app(services!.routineDestination!)); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ availability: "available", preference: { revision: 1, target: TARGET_A } });
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});
it("native owner CAS admits exactly one concurrent switch and preserves original request/routine authority", async () => {
  const service = createRoutineCliDestinationService({ db: f.db, agents: f.agents, ownerId: OWNER, computerId: scope.computerId });
  const results = await Promise.all([call(app(service), { ...TARGET_A, baseRevision: 1 }), call(app(service), { ...TARGET_B, baseRevision: 1 })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const current = await call(app(service)); expect(await current.json()).toMatchObject({ preference: { revision: 2 }, availability: "available" });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});
it("stored preference and live availability stay on one locked revision while a concurrent owner switch waits", async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const reader = createRoutineCliTargetService({ db: f.db, agents: f.agents, scope, canAccessTarget: async (target, trx) => {
    if (target.action === "read") { entered(); await gate; }
    return Boolean(await trx.selectFrom("chats").select("id").where("id", "=", target.chatId).where("owner_id", "=", OWNER).executeTakeFirst());
  } });
  const reading = call(app(reader)); void reading.catch(() => undefined); let writing: Promise<Response> | undefined;
  try {
    await reached; writing = call(app(f.targets), { ...TARGET_B, baseRevision: 1 }); void writing.catch(() => undefined);
    let waiting = false; const end = Date.now() + 3000;
    while (Date.now() < end) {
      const row = (await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=((hashtextextended(${JSON.stringify(["routine-cli-target", scope.ownerId, scope.computerId])},0)>>32)&4294967295)::oid AND objid=(hashtextextended(${JSON.stringify(["routine-cli-target", scope.ownerId, scope.computerId])},0)&4294967295)::oid AND cardinality(pg_blocking_pids(pid))>0) AS waiting`.execute(f.db)).rows[0];
      if (row?.waiting) { waiting = true; break; } await delay(10);
    }
    expect(waiting).toBe(true); release();
    const original = await reading; expect(await original.json()).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "available" });
    expect((await writing).status).toBe(200); expect(await (await call(app(f.targets))).json()).toMatchObject({ preference: { revision: 2, target: TARGET_B }, availability: "available" });
  } finally { release(); await Promise.allSettled([reading, ...(writing ? [writing] : [])]); }
});

it("actual startup preserves distinct configured owner principal scopes without rewriting existing target data", async () => {
  const configuredOwnerIds = [OWNER, "user_configured_clerk"];
  const input = { homePath: f.home, repository: f.chats, agents: f.agents, runtimeOwnerId: OWNER, computerId: scope.computerId, configuredOwnerIds,
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() } };
  services = await startBots(input);
  const principal = { userId: configuredOwnerIds[1]!, source: "jwt" as const };
  expect(await services!.routineDestination!.getOwnerView(principal)).toMatchObject({ preference: { revision: 0, target: null }, availability: "unset" });
  await expect(services!.routineDestination!.remember(principal, { ...TARGET_A, baseRevision: 0 })).rejects.toMatchObject({ code: "target_unavailable" });
  expect(await services!.routineDestination!.getOwnerView(f.principal)).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "available" });
  await expect(services!.routineDestination!.getOwnerView({ userId: "foreign_owner", source: "jwt" })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});
