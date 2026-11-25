import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayChatEventStream } from "../../packages/gateway/src/chat/gateway-event-stream.js";
import { bootstrapNotificationDatabase, type NotificationDatabase } from "../../packages/gateway/src/notifications/schema.js";
import { createNotificationRouter } from "../../packages/gateway/src/notifications/router.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createRealCollaborationTestDatabase } from "./collaboration-test-support.js";
import { createNotificationRepository } from "../../packages/gateway/src/notifications/repository.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createNotificationPreferenceRuntime } from "../../packages/gateway/src/notifications/runtime.js";
import { createReviewStore } from "../../packages/gateway/src/review-store.js";
import { createPushTokenStore } from "../../packages/gateway/src/notifications/push-tokens.js";
import { initializeGatewayChannels } from "../../packages/gateway/src/startup/channels.js";
import type { OwnerDatabaseServices } from "../../packages/gateway/src/startup/owner-database.js";
import { createConversationStore } from "../../packages/gateway/src/conversations.js";

describe("canonical attention delivery", () => {
  let repository: ChatRepository;
  let db: Kysely<NotificationDatabase>;
  let router: ReturnType<typeof createNotificationRouter>;
  let stream: ReturnType<typeof createGatewayChatEventStream>;
  let now: number;
  let cleanup: () => Promise<void>;
  const owner = { type: "personal" as const, ownerId: "owner_notifications" };
  const send = vi.fn().mockResolvedValue(undefined);
  const preferences = vi.fn().mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);

  beforeEach(async () => {
    if (process.env.MATRIX_TEST_POSTGRES_URL) {
      const fixture = await createRealCollaborationTestDatabase();
      repository = new ChatRepository(fixture.db);
      cleanup = fixture.destroy;
    } else {
      const instance = await createTestPGlite();
      repository = new ChatRepository(new Kysely({ dialect: instance.dialect }));
      cleanup = () => repository.kysely.destroy();
    }
    await repository.bootstrap();
    db = repository.kysely as unknown as Kysely<NotificationDatabase>;
    await bootstrapNotificationDatabase(db);
    now = Date.now() + 1000;
    send.mockReset().mockResolvedValue(undefined); preferences.mockReset().mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    router = createNotificationRouter({ db, ownerId: owner.ownerId, preferences, transport: { send }, now: () => now });
    stream = createGatewayChatEventStream({ repository, capture: vi.fn(), onChatEvent: router.onChatEvent });
  });
  afterEach(async () => { stream?.shutdown(); await router?.close(); await cleanup?.(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function request(type: "approval" | "question" = "approval", requestOwner = owner) {
    const { snapshot } = createCanonicalChatFixture("running");
    const chatId = snapshot.chat.id;
    await repository.create(requestOwner, { id: chatId, clientRequestId: "req_notification", title: "Private chat title" });
    const { startedAt: _startedAt, ...run } = snapshot.runs[0]!;
    await repository.admitTurn(requestOwner, { chatId, baseRevision: 0, message: snapshot.messages[0]!,
      turn: { ...snapshot.turns[0]!, status: "accepted" }, run: { ...run, status: "accepted" } });
    const ids = { chatId, runId: run.id };
    await repository.markRunRunning(requestOwner, { ...ids, startedAt: new Date(now).toISOString() });
    await repository.appendRunActivities(requestOwner, chatId, run.id, [{ ...ids, id: "activity_attention", occurredAt: new Date(now).toISOString(),
      ...(type === "approval" ? { type: "approval.requested" as const, approvalId: "approval_attention", title: "Private approval",
        risk: "low" as const, allowedDecisions: ["approve" as const, "decline" as const] }
        : { type: "input.requested" as const, requestId: "input_attention", title: "Private question",
          questions: [{ questionId: "q_one", header: "Choice", question: "Which?", multiSelect: false, allowOther: true }] }),
    }]);
    return ids;
  }

  it.each(["approval", "question"] as const)("pushes a pending %s once after 15 seconds with private copy by default", async kind => {
    await request(kind);
    await router.flush(); await router.tick();
    expect(send).not.toHaveBeenCalled();
    now += 15_000;
    await router.tick(); await router.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ kind, title: "Matrix OS", body: kind === "approval" ? "Your agent needs approval" : "Your agent has a question" });
    expect(JSON.stringify(send.mock.calls)).not.toContain("Private");
  });

  it("does not push an approval answered during the grace", async () => {
    const ids = await request();
    await router.flush();
    await repository.appendRunActivities(owner, ids.chatId, ids.runId, [{ ...ids, id: "activity_answered", type: "approval.resolved",
      approvalId: "approval_attention", decision: "approve", occurredAt: new Date(now + 1000).toISOString() }]);
    now += 15_000; await router.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("recovers a committed request when the process dies before enqueue", async () => {
    stream.shutdown();
    await request();
    await router.close();
    router = createNotificationRouter({ db, ownerId: owner.ownerId, preferences, transport: { send }, now: () => now });
    await router.reconcile();
    now += 15_000; await router.tick(); await router.reconcile(); await router.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["kind", "phone", "unavailable"])("fails closed for %s preferences", async reason => {
    await request(); await router.flush();
    if (reason === "unavailable") preferences.mockRejectedValue(new Error("private storage diagnostic"));
    else preferences.mockResolvedValue({ ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, approval: reason !== "kind" },
      phone: { ...DEFAULT_NOTIFICATION_PREFERENCES.phone, mode: reason === "phone" ? "never" : "when_away" } });
    now += 15_000; await router.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not revive requests from before the A6 migration or finished runs", async () => {
    const ids = await request();
    await router.flush();
    await db.deleteFrom("notification_events").execute();
    await db.updateTable("notification_schema_migrations").set({ applied_at: new Date(now + 1000) } as never).where("version", "=", 2).execute();
    await router.reconcile();
    expect(await db.selectFrom("notification_events").selectAll().execute()).toEqual([]);
    await repository.finishRun(owner, { ...ids, outcome: "completed", completedAt: new Date(now + 2000).toISOString() });
    now += 15_000; await router.reconcile(); await router.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("uses opt-in preview and retries transport failures with a three-attempt cap", async () => {
    await request(); await router.flush();
    preferences.mockResolvedValue({ ...DEFAULT_NOTIFICATION_PREFERENCES,
      content: { showPreview: true, sound: false, timeSensitive: true } });
    send.mockRejectedValue(new Error("transport unavailable"));
    now += 15_000; await router.tick();
    expect(send.mock.calls[0][0]).toMatchObject({ body: "Private approval", sound: false, timeSensitive: true });
    now += 2000; await router.tick(); now += 8000; await router.tick(); now += 30_000; await router.tick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(await db.selectFrom("notification_events").select(["state", "push_attempts"]).execute()).toEqual([{ state: "failed", push_attempts: 3 }]);
    expect(await db.selectFrom("notification_attempts").select("outcome").execute()).toHaveLength(3);
  });

  it("ignores late work after shutdown", async () => {
    await request(); await router.flush(); await router.close();
    now += 15_000; await router.tick(); await router.reconcile();
    expect(send).not.toHaveBeenCalled();
  });

  it("recovers a claim abandoned before send and rejects a stale worker's completion", async () => {
    await request(); await router.flush(); now += 15_000;
    const persistence = createNotificationRepository(db, owner.ownerId);
    const [abandoned] = await persistence.claim(now);
    expect(abandoned?.state).toBe("sending");
    await router.close();
    router = createNotificationRouter({ db, ownerId: owner.ownerId, preferences, transport: { send }, now: () => now });
    now += 61_000; await router.tick();
    await persistence.finish(abandoned!, "failed", now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("notification_events").select("state").execute()).toEqual([{ state: "pushed" }]);
  });

  it("serializes overlapping gateway schedulers without duplicate transport calls", async () => {
    await request(); await router.flush(); now += 15_000;
    const other = createNotificationRouter({ db, ownerId: owner.ownerId, preferences, transport: { send }, now: () => now });
    try {
      await Promise.all([router.reconcile(), other.reconcile()]);
      await Promise.all([router.tick(), other.tick()]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await db.selectFrom("notification_attempts").select("outcome").execute()).toEqual([{ outcome: "sent" }]);
    } finally { await other.close(); }
  });

  it("does not enqueue or recover another owner's requests", async () => {
    await request("approval", { type: "personal", ownerId: "owner_foreign" });
    await router.flush(); await router.reconcile(); now += 15_000; await router.tick();
    expect(send).not.toHaveBeenCalled();
    expect(await db.selectFrom("notification_events").selectAll().execute()).toEqual([]);
  });

  it("does not push submitted input while its runner is still settling the answer", async () => {
    const ids = await request("question"); await router.flush();
    await repository.appendRunActivities(owner, ids.chatId, ids.runId, [{ ...ids, id: "activity_submitted", type: "input.submitted",
      requestId: "input_attention", clientRequestId: "req_answer", occurredAt: new Date(now + 1000).toISOString() }]);
    now += 15_000; await router.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("wires the real channel transport and suppresses the first canonical Codex approval before its adapter binding exists", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-a6-runtime-"));
    vi.stubEnv("MATRIX_USER_ID", owner.ownerId); vi.stubEnv("MATRIX_HANDLE", "attention-test"); vi.stubEnv("MATRIX_NOTIFICATIONS_ROUTER", "on");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }] })));
    const runtime = createNotificationPreferenceRuntime({ homePath, env: process.env, reviewStore: createReviewStore({ homePath }) });
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex", startThread({ thread, nextEventId }) {
      return [AgentThreadEventSchema.parse({ type: "approval.requested", eventId: nextEventId(), threadId: thread.id,
        occurredAt: new Date(now).toISOString(), approval: { approvalId: "approval_attention", threadId: thread.id,
          title: "Private approval", safeDescription: "Review the request", risk: "low", actionKind: "command",
          allowedDecisions: ["approve", "decline"], correlationId: "corr_attention" } })];
    } }] });
    const configPath = join(homePath, "system/config.json");
    await runtime.legacy.preferences.load({ userId: owner.ownerId, source: "configured-container" });
    await writeFile(configPath, JSON.stringify({ channels: {} }));
    const tokens = createPushTokenStore(db);
    await tokens.register({ token: "test_device_token", platform: "ios", ownerId: owner.ownerId, seenAt: new Date(now), maxPerOwner: 16 });
    const services = { kyselyInstance: db, chatRepository: repository } as unknown as OwnerDatabaseServices;
    await router.close(); stream.shutdown();
    const channels = initializeGatewayChannels({ homePath, configPath, codingAgentThreadStore: threads,
      codingAgentNotificationPreferenceStore: runtime.legacy, notificationServices: services, pushTokens: tokens,
      conversations: createConversationStore(homePath), dispatcher: { dispatch: async () => { throw new Error("unused"); } } as never,
      finalizeWithSummary: async () => {}, logBestEffortFailure: vi.fn(), channelStt: async () => { throw new Error("unused"); } });
    router = services.notificationRouter!;
    stream = createGatewayChatEventStream({ repository, capture: vi.fn(), onChatEvent: input => services.notificationRouter?.onChatEvent(input) });
    const legacySend = vi.spyOn(channels.channelManager, "send").mockResolvedValue(undefined);
    try {
      const ids = await request();
      await threads.createThread({ userId: owner.ownerId, source: "configured-container" }, { providerId: "codex", prompt: "Review",
        clientRequestId: `req_${ids.runId.slice(4)}` });
      await router.flush(); now += 15_000; await router.tick();
      expect(legacySend).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)[0]).toMatchObject({ channelId: "attention",
        data: { v: 1, handle: "attention-test", target: { type: "chat", chatId: ids.chatId } }, interruptionLevel: "active" });
      vi.stubEnv("MATRIX_NOTIFICATIONS_ROUTER", "off");
      await threads.createThread({ userId: owner.ownerId, source: "configured-container" }, { providerId: "codex", prompt: "Review",
        clientRequestId: "req_standalone" });
      await vi.waitFor(() => expect(legacySend).toHaveBeenCalledTimes(1));
    } finally {
      await channels.closeChannels(); await channels.channelManager.stop(); await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
