import { afterEach, expect, it, vi } from "vitest";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import { createBotStateDatabase, insertChat, OWNER } from "./bot-state-support.js";
import { requestFixture, scope } from "./routine-cli-request-support.js";
import { Hono } from "hono";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { registerCollaborationChatRoutes } from "../../../packages/gateway/src/server/collaboration-chat-routes.js";

let data: Awaited<ReturnType<typeof createBotStateDatabase>> | undefined;
let fixture: Awaited<ReturnType<typeof requestFixture>> | undefined;
let services: BotServices | undefined;
let routes: { close(): Promise<void> } | undefined;
afterEach(async () => {
  try { await routes?.close(); await services?.close(); await fixture?.close(); }
  finally { await data?.destroy(); data = undefined; fixture = undefined; services = undefined; routes = undefined; vi.unstubAllEnvs(); }
});

function app() {
  const application = new Hono(); application.use("*", authMiddleware("fixture-owner-token"));
  routes = registerCollaborationChatRoutes({ app: application, upgradeWebSocket: (() => {}) as never,
    canonicalChatEventStream: null, chatRepository: fixture!.chats, runtimeOwnerIds: [OWNER],
    gatewayCollaboration: null, collaborationFailClosedReason: null,
    canonicalChatOrchestrator: { admitTurn: vi.fn(), enqueueQueuedTurn: vi.fn() } as never,
    canonicalChatExecutionRoots: null, canonicalChatCollaborationGuard: null, projectOwnerToolOutput: {} as never,
    canonicalChatRuntime: null, canonicalChatProviderCatalog: {} as never, aiProviderService: {} as never,
    providerSettingsStore: {} as never, botServices: services });
  return application;
}

async function start(configured: boolean) {
  data = await createBotStateDatabase(); fixture = await requestFixture(data.db);
  vi.stubEnv("MATRIX_USER_ID", OWNER); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-owner-token");
  services = await startBots({ homePath: fixture.home, repository: fixture.chats, agents: fixture.agents,
    runtimeOwnerId: OWNER, computerId: scope.computerId, configuredOwnerIds: [OWNER],
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    ...(configured ? { routineActionPlatform: { platformUrl: "https://platform.example.test", token: "fixture-runtime-transport",
      handle: "computer-one", machineId: "machine_current", runtimeSlot: "primary" } } : {}) });
  if (!services) throw new Error("Actual Bot startup unavailable");
  return { data, fixture, services };
}

it("wires real source-origin reads and verified decision dependencies without creating another Bot or granting authority", async () => {
  const f = await start(true);
  expect(f.services.routineOrigin).toBeDefined();
  expect(f.services.routineOriginProofs?.verifyApproval).toBeTypeOf("function");
  expect(f.services.beforeRoutineCreationAdmission).toBeTypeOf("function");
  await insertChat(f.data.db, "chat_origin_startup");
  const before = await f.data.db.selectFrom("bot_chat_bindings").selectAll().execute();
  expect(await f.services.routineOrigin!.read(OWNER, "chat_origin_startup")).toEqual({
    sourceChatId: "chat_origin_startup", pending: [], deliveries: [], hasMore: false,
  });
  const read = await app().request("/api/chats/chat_origin_startup/routine-origin", {
    headers: { authorization: "Bearer fixture-owner-token" },
  });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ sourceChatId: "chat_origin_startup", pending: [], deliveries: [] });
  await f.services.routineOrigin!.wake();
  expect(await f.data.db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual(before);
  expect(await f.data.db.selectFrom("bot_grants").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  await f.services.routineOrigin!.close(); await f.services.routineOrigin!.close();
  await expect(f.services.routineOrigin!.wake()).resolves.toBeUndefined();
});

it("keeps ordinary Bot startup available when trusted Platform source approval is not configured", async () => {
  const f = await start(false);
  expect(f.services.routineDestination).toBeDefined();
  expect(f.services.routineOrigin).toBeUndefined();
  expect(f.services.beforeRoutineCreationAdmission).toBeUndefined();
  const read = await app().request("/api/chats/chat_origin_startup/routine-origin", {
    headers: { authorization: "Bearer fixture-owner-token" },
  });
  expect(read.status).toBe(503);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
});
