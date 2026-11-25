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
  afterEach(async () => { stream?.shutdown(); await router?.close(); await cleanup?.(); });

  async function request(type: "approval" | "question" = "approval") {
    const { snapshot } = createCanonicalChatFixture("running");
    const chatId = snapshot.chat.id;
    await repository.create(owner, { id: chatId, clientRequestId: "req_notification", title: "Private chat title" });
    const { startedAt: _startedAt, ...run } = snapshot.runs[0]!;
    await repository.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!,
      turn: { ...snapshot.turns[0]!, status: "accepted" }, run: { ...run, status: "accepted" } });
    const ids = { chatId, runId: run.id };
    await repository.markRunRunning(owner, { ...ids, startedAt: new Date(now).toISOString() });
    await repository.appendRunActivities(owner, chatId, run.id, [{ ...ids, id: "activity_attention", occurredAt: new Date(now).toISOString(),
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
});
