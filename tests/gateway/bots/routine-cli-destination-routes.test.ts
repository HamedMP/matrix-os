import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../../packages/gateway/src/request-principal.js";
import { createRoutineCliDestinationRoutes } from "../../../packages/gateway/src/bots/routine-cli-destination-routes.js";
import { createBotStateDatabase, OWNER } from "./bot-state-support.js";
import { createRoutineCliDestinationService } from "../../../packages/gateway/src/bots/routine-cli-destination-service.js";
import { requestFixture, TARGET_A, TARGET_B, scope } from "./routine-cli-request-support.js";
let data: Awaited<ReturnType<typeof createBotStateDatabase>>, f: Awaited<ReturnType<typeof requestFixture>>;
beforeEach(async () => {
  data = await createBotStateDatabase(); f = await requestFixture(data.db);
  vi.stubEnv("MATRIX_USER_ID", OWNER); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-owner-token");
});
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); await data?.destroy(); });
function application(targets: Parameters<typeof createRoutineCliDestinationRoutes>[0]["targets"] = createRoutineCliDestinationService({ db: f.db, agents: f.agents, ownerId: OWNER, computerId: scope.computerId })) {
  const app = new Hono(); app.use("*", authMiddleware("fixture-owner-token"));
  app.route("/", createRoutineCliDestinationRoutes({ targets, getPrincipal: requireRequestPrincipal })); return app;
}
const call = (app: Hono, method = "GET", body?: unknown, suffix = "", authorization = "Bearer fixture-owner-token") => app.request(`/api/routine-cli/destination${suffix}`, {
  method, headers: { authorization, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
it("actual owner-auth route reads durable current destination without changing permission/approval state", async () => {
  const app = application(), before = await f.targets.getStoredPreference(f.principal);
  const result = await call(app); expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ preference: before, availability: "available" });
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("routine_cli_sources").selectAll().execute()).toHaveLength(1); // Existing fixture only; GET creates none.
});
it("explicit owner remember/reset uses real target service CAS and survives fresh HTTP read", async () => {
  const app = application();
  const saved = await call(app, "POST", { ...TARGET_B, baseRevision: 1 }); expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ preference: { revision: 2, target: TARGET_B }, availability: "available" });
  expect((await call(app, "POST", { ...TARGET_A, baseRevision: 1 })).status).toBe(409);
  expect(await (await call(application())).json()).toMatchObject({ preference: { revision: 2, target: TARGET_B }, availability: "available" });
  const reset = await call(app, "POST", { baseRevision: 2 }, "/reset"); expect(reset.status).toBe(200);
  expect(await reset.json()).toMatchObject({ preference: { revision: 3, target: null }, availability: "unset" });
});
it.each(["archived", "shared", "removed", "foreign owner"])("stored %s target remains recoverable and never falls back", async fault => {
  if (fault === "archived") await f.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", TARGET_A.chatId).execute();
  if (fault === "shared") await f.db.updateTable("chats").set({ collaboration: {} as never }).where("id", "=", TARGET_A.chatId).execute();
  if (fault === "removed") await f.db.updateTable("bot_chat_bindings").set({ removed_at: f.state.clock }).where("chat_id", "=", TARGET_A.chatId).execute();
  if (fault === "foreign owner") await f.db.updateTable("chats").set({ owner_id: "foreign_owner" }).where("id", "=", TARGET_A.chatId).execute();
  const app = application(), read = await call(app); expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "unavailable" });
  expect((await call(app, "POST", { ...TARGET_A, baseRevision: 1 })).status).toBe(409);
  expect((await call(app, "POST", { baseRevision: 1 }, "/reset")).status).toBe(200);
  expect(await (await call(app)).json()).toMatchObject({ preference: { revision: 2, target: null }, availability: "unset" });
});
it("same Bot/Chat with a new binding incarnation requires explicit owner reselection", async () => {
  const { sql } = await import("kysely");
  await sql`UPDATE bot_chat_bindings SET created_at='2026-09-27T12:00:00.123456Z' WHERE chat_id=${TARGET_A.chatId}`.execute(f.db);
  const app = application(); expect(await (await call(app)).json()).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "unavailable" });
  const selected = await call(app, "POST", { ...TARGET_A, baseRevision: 1 }); expect(selected.status).toBe(200);
  expect(await selected.json()).toMatchObject({ preference: { revision: 2, target: { ...TARGET_A, bindingCreatedAt: "2026-09-27T12:00:00.123456Z" } }, availability: "available" });
});
it("source credentials cannot read/edit preferences; no auth or a foreign JWT owner also fails", async () => {
  const app = application(), token = await f.token({ operation: "list" });
  for (const method of ["GET", "POST"]) for (const auth of ["", `RoutineCapability ${token}`]) expect((await call(app, method, method === "POST" ? { ...TARGET_B, baseRevision: 1 } : undefined, "", auth)).status).toBe(401);
  const { SignJWT } = await import("jose"), secret = "routine-destination-fixture-jwt-secret-32bytes";
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", ""); vi.stubEnv("PLATFORM_JWT_SECRET", secret); vi.stubEnv("MATRIX_HANDLE", "fixture");
  const jwt = await new SignJWT({ handle: "fixture", gateway_url: "https://fixture.invalid" }).setProtectedHeader({ alg: "HS256" }).setSubject("foreign_owner")
    .setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(secret));
  expect((await call(app, "POST", { ...TARGET_B, baseRevision: 1 }, "", `Bearer ${jwt}`)).status).toBe(403);
  expect(await f.targets.getStoredPreference(f.principal)).toMatchObject({ revision: 1, target: TARGET_A });
});
it.each(["ownerId", "computerId", "source", "grant", "permission", "bindingCreatedAt"])("strict owner navigation payload rejects %s override without writes", async key => {
  const app = application(); expect((await call(app, "POST", { ...TARGET_B, baseRevision: 1, [key]: "forged" })).status).toBe(400);
  expect((await call(app, "POST", { baseRevision: 1, [key]: "forged" }, "/reset")).status).toBe(400);
  expect(await f.targets.getStoredPreference(f.principal)).toMatchObject({ revision: 1, target: TARGET_A });
});
it("both mutation body limits run before JSON; missing configured feature is explicit503 and missing dependencies fail registration", async () => {
  for (const suffix of ["", "/reset"]) {
    const result = await application().request(`/api/routine-cli/destination${suffix}`, { method: "POST", headers: { authorization: "Bearer fixture-owner-token" }, body: " ".repeat(2049) });
    expect(result.status).toBe(413);
  }
  expect((await call(application(null))).status).toBe(503);
  expect(() => createRoutineCliDestinationRoutes({ targets: undefined, getPrincipal: requireRequestPrincipal } as never)).toThrow();
  expect(() => createRoutineCliDestinationRoutes({ targets: f.targets, getPrincipal: undefined } as never)).toThrow();
});
it("database/config errors stay errors and never masquerade as a recoverable invalid default", async () => {
  const { createRoutineCliTargetService } = await import("../../../packages/gateway/src/bots/routine-cli-targets.js"), { scope } = await import("./routine-cli-request-support.js");
  const service = createRoutineCliTargetService({ db: f.db, scope, agents: f.agents });
  expect((await call(application(service))).status).toBe(503);
  const broken = { ...f.targets, getOwnerView: async () => { throw new Error("private provider path"); } };
  const response = await call(application(broken)); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private provider");
});
it("owner+Computer scopes isolate preferences and repeated read performs no auto-selection", async () => {
  const { createRoutineCliDestinationService } = await import("../../../packages/gateway/src/bots/routine-cli-destination-service.js");
  const other = createRoutineCliDestinationService({ db: f.db, agents: f.agents, ownerId: OWNER, computerId: "other-computer" });
  for (let n = 0; n < 3; n++) expect(await (await call(application(other))).json()).toEqual({ preference: { revision: 0, target: null, updatedAt: null }, availability: "unset" });
  expect(await f.db.selectFrom("routine_cli_preferences").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});
it("owner destination composition rejects missing real DB/agent dependencies at construction", () => {
  expect(() => createRoutineCliDestinationService({ db: f.db, agents: undefined, ownerId: OWNER, computerId: scope.computerId } as never)).toThrow();
  expect(() => createRoutineCliDestinationService({ db: undefined, agents: f.agents, ownerId: OWNER, computerId: scope.computerId } as never)).toThrow();
});
it("real shared BotClient consumes actual owner HTTP/service DTOs and CAS without a parallel response fixture", async () => {
  const { createBotClient } = await import("../../../packages/ui/src/chat-agents/bots/client.js"), app = application();
  const client = createBotClient(async (path, method, body) => {
    const response = await app.request(path, { method, headers: { authorization: "Bearer fixture-owner-token", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw { status: response.status };
    return response.json();
  }).routineDestination!;
  expect(await client.get()).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "available" });
  expect(await client.remember({ ...TARGET_B, baseRevision: 1 })).toMatchObject({ preference: { revision: 2, target: TARGET_B }, availability: "available" });
  await expect(client.remember({ ...TARGET_A, baseRevision: 1 })).rejects.toMatchObject({ status: 409 });
  expect(await client.get()).toMatchObject({ preference: { revision: 2, target: TARGET_B } });
  expect(await client.reset({ baseRevision: 2 })).toMatchObject({ preference: { revision: 3, target: null }, availability: "unset" });
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});

it("distinct configured platform and Clerk owners retain their actual private Bot data and separate preferences", async () => {
  const clerkOwner = "user_configured_clerk", target = { botId: "bot_clerkowned", chatId: "chat_clerk_owned" };
  const { insertChat, NOW } = await import("./bot-state-support.js");
  const { createBotBindingsRepository } = await import("../../../packages/gateway/src/bots/repositories/bindings.js");
  await insertChat(f.db, target.chatId, clerkOwner);
  await f.agents.createRecipeBot({ type: "personal", ownerId: clerkOwner }, { id: target.botId, createHash: "c".repeat(64),
    fields: { name: "Clerk Bot", description: "", instructions: "Read", selection: { instanceId: "matrix_pi_default", model: "auto" } }, recipeRef: { recipeId: "report", version: "1" } });
  await createBotBindingsRepository(f.db).bindDirect({ ownerId: clerkOwner, ...target, now: NOW });
  const configuredOwnerIds = [OWNER, clerkOwner];
  const input = { db: f.db, agents: f.agents, ownerId: OWNER, computerId: scope.computerId, configuredOwnerIds };
  const service = createRoutineCliDestinationService(input), app = application(service);
  const { SignJWT } = await import("jose"), secret = "routine-configured-owner-fixture-jwt-secret-32bytes";
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", ""); vi.stubEnv("PLATFORM_JWT_SECRET", secret); vi.stubEnv("MATRIX_HANDLE", "fixture");
  const sign = (userId: string) => new SignJWT({ handle: "fixture", gateway_url: "https://fixture.invalid" }).setProtectedHeader({ alg: "HS256" }).setSubject(userId)
    .setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(secret));
  const jwt = await sign(clerkOwner);
  const read = await call(app, "GET", undefined, "", `Bearer ${jwt}`); expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ preference: { revision: 0, target: null }, availability: "unset" });
  expect((await call(app, "POST", { ...TARGET_A, baseRevision: 0 }, "", `Bearer ${jwt}`)).status).toBe(409);
  expect((await call(app, "POST", { ...target, baseRevision: 0 }, "", `Bearer ${jwt}`)).status).toBe(200);
  expect(await (await call(app)).json()).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "available" });
  expect(await (await call(app, "GET", undefined, "", `Bearer ${jwt}`)).json()).toMatchObject({ preference: { revision: 1, target }, availability: "available" });
  configuredOwnerIds[1] = "foreign_owner";
  expect((await call(app, "GET", undefined, "", `Bearer ${jwt}`)).status).toBe(200); // Captured configuration, no mutable alias rewrite.
  expect((await call(app, "GET", undefined, "", `Bearer ${await sign("foreign_owner")}`)).status).toBe(403);
  expect((await call(app, "GET", undefined, "", `RoutineCapability ${await f.token({ operation: "list" })}`)).status).toBe(401);
  expect(await f.db.selectFrom("routine_cli_preferences").selectAll().execute()).toHaveLength(2);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0); expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
});

it.each([[], [OWNER, "user_a", "user_b"], [OWNER, "../unsafe"], ["user_other"]].map(configuredOwnerIds => ({ configuredOwnerIds })))("invalid configured owner set $configuredOwnerIds stays unavailable", ({ configuredOwnerIds }) => {
  expect(createRoutineCliDestinationService({ db: f.db, agents: f.agents, ownerId: OWNER, computerId: scope.computerId, configuredOwnerIds })).toBeNull();
});
it("duplicate fixed configured owners preserve the one existing preference scope", async () => {
  const service = createRoutineCliDestinationService({ db: f.db, agents: f.agents, ownerId: OWNER, computerId: scope.computerId, configuredOwnerIds: [OWNER, OWNER] });
  expect(await service!.getOwnerView(f.principal)).toMatchObject({ preference: { revision: 1, target: TARGET_A }, availability: "available" });
  expect(await f.db.selectFrom("routine_cli_preferences").selectAll().execute()).toHaveLength(1);
});
