import { afterEach, describe, expect, it, vi } from "vitest";
import { sql, type KyselyPlugin } from "kysely";
import { CanonicalChatListResponseSchema, CanonicalChatNavigationResponseSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatNavigationRepository } from "../../packages/gateway/src/chat/navigation-repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
const owner = { type: "personal" as const, ownerId: "navigation_owner" };
let fixture: CollaborationTestDatabase | undefined;
afterEach(async () => { await fixture?.destroy(); fixture = undefined; });
async function setup(real = false) {
  fixture = await (real ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
  const repository = new ChatRepository(fixture.db);
  await repository.bootstrap();
  // This fixture has no agent-library row: bindings remain authoritative even when a Bot is archived.
  await sql`CREATE TABLE bot_chat_bindings (owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ)`.execute(fixture.db);
  const count = { value: 0 };
  const plugin: KyselyPlugin = { transformQuery(args) { count.value += 1; return args.node; }, async transformResult(args) { return args.result; } };
  const navigation = createChatNavigationRepository(fixture.db.withPlugin(plugin));
  const service = createCanonicalChatService(repository, { navigation });
  return { repository, navigation, service, count, db: fixture.db };
}
async function seed(db: NonNullable<typeof fixture>["db"], size: number, ownerId = owner.ownerId) {
  await sql`INSERT INTO chats (id,owner_type,owner_id,create_request_id,title,lifecycle,attention,activity_at)
    SELECT 'chat_' || ${ownerId} || '_' || i, 'personal', ${ownerId}, 'req_' || i, 'Title ' || i,
      'active', 'none', '2026-10-08T00:00:00Z'::timestamptz FROM generate_series(1,${size}::int) i`.execute(db);
}
for (const [label, real] of [["PostgreSQL-compatible", false], ["real PostgreSQL", true]] as const) {
  const suite = real && !process.env.MATRIX_TEST_POSTGRES_URL ? describe.skip : describe;
  suite(`${label} navigation snapshot`, () => {
    it.each([1, 150, 1000])("uses one consistent owner-filtered statement at %i rows", async size => {
      const { db, navigation, count } = await setup(real);
      await seed(db, size);
      await seed(db, 2, "outsider");
      const snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      expect(count.value).toBe(1);
      expect(snapshot.items).toHaveLength(size);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.items.every(item => item.chat.id.startsWith("chat_navigation_owner_"))).toBe(true);
      expect(snapshot.items.every(item => item.classification.kind === "ordinary")).toBe(true);
      CanonicalChatNavigationResponseSchema.parse(snapshot);
    });
    it("preserves read/pin/attention and classifies archived/removed/group bindings safely", async () => {
      const { db, navigation, repository } = await setup(real);
      await seed(db, 4);
      await sql`UPDATE chats SET attention='input_required', user_state='{"readThroughSeq":0,"pinned":true,"muted":false}'::jsonb
        WHERE id='chat_navigation_owner_1'`.execute(db);
      await sql`INSERT INTO chat_user_state(chat_id,principal_id,pinned,muted,read_through_seq,marked_unread)
        VALUES ('chat_navigation_owner_1',${owner.ownerId},true,false,0,true)`.execute(db);
      await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,removed_at) VALUES
        (${owner.ownerId},'bot_archived1','chat_navigation_owner_1','direct',null),
        (${owner.ownerId},'bot_removed01','chat_navigation_owner_2','direct',now()),
        (${owner.ownerId},'bot_group0001','chat_navigation_owner_3','group',null),
        ('outsider','bot_other0001','chat_navigation_owner_4','direct',null)`.execute(db);
      const snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      const first = snapshot.items.find(item => item.chat.id.endsWith('_1'))!;
      const detail = await repository.get(owner, first.chat.id);
      expect(first.classification).toEqual({ kind: 'bot', agentId: 'bot_archived1' });
      expect(first.chat.userState).toEqual(detail?.chat.userState);
      expect(first.chat.attention).toBe('input_required');
      expect(first.readState).toEqual(detail?.readState);
      expect(snapshot.items.filter(item => item.classification.kind === 'ordinary')).toHaveLength(3);
      expect(first.chat).not.toHaveProperty('currentSelection');
      expect(first.chat).not.toHaveProperty('ownerScope');
    });
    it("shares active-run, completion acknowledgement and incoming-message derivation with details", async () => {
      const { db, navigation, repository } = await setup(real);
      await seed(db, 2);
      for (let index = 1; index <= 2; index += 1) {
        const chatId = `chat_navigation_owner_${index}`;
        const now = "2026-10-08T01:00:00.000Z";
        await repository.admitTurn(owner, { chatId, baseRevision: 0,
          message: { id: `msg_navigation_${index}`, chatId, seq: 1, role: "user", state: "committed",
            turnId: `cturn_navigation_${index}`, parts: [{ type: "text", text: "Input" }], createdAt: now },
          turn: { id: `cturn_navigation_${index}`, chatId, clientRequestId: `req_turn_navigation_${index}`,
            baseMessageSeq: 0, inputMessageId: `msg_navigation_${index}`, status: "accepted", createdAt: now, updatedAt: now },
          run: { id: `run_navigation_${index}`, chatId, turnId: `cturn_navigation_${index}`, attempt: 1,
            driverKind: "codex", instanceId: "codex_default", selection: { instanceId: "codex_default", model: "test" },
            interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0,
            capabilitySnapshot: { revision: "test", rootChat: true, resume: true, cancellation: true, steering: "same_run",
              attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional", resources: [],
              interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: now, updatedAt: now },
        });
      }
      await repository.finishRun(owner, { chatId: "chat_navigation_owner_2", runId: "run_navigation_2",
        outcome: "completed", completedAt: "2026-10-08T01:01:00.000Z",
        output: { id: "msg_navigation_output", chatId: "chat_navigation_owner_2", seq: 2, role: "assistant",
          state: "committed", runId: "run_navigation_2", turnId: "cturn_navigation_2",
          parts: [{ type: "text", text: "Output" }], createdAt: "2026-10-08T01:01:00.000Z" },
      });
      let snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      for (const item of snapshot.items) {
        const detail = await repository.get(owner, item.chat.id);
        expect(item.activeRun).toEqual(detail?.activeRun);
        expect(item.latestSuccessfulCompletion).toEqual(detail?.latestSuccessfulCompletion);
        expect(item.readState).toEqual(detail?.readState);
        expect(item.providerBinding?.driverKind).toEqual(detail?.providerBinding?.driverKind);
      }
      const completed = snapshot.items.find(item => item.chat.id.endsWith('_2'))!;
      expect(completed.readState.unread).toBe(true);
      expect(completed.latestSuccessfulCompletion?.unacknowledged).toBe(true);
      await repository.acknowledgeCompletion(owner, completed.chat.id, 'run_navigation_2');
      snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      expect(snapshot.items.find(item => item.chat.id === completed.chat.id)?.latestSuccessfulCompletion?.unacknowledged).toBe(false);
    });
    it("tags membership-dependent metadata as memory-only and preserves lifecycle filtering", async () => {
      const { db, navigation } = await setup(real);
      await seed(db, 2);
      await sql`UPDATE chats SET collaboration='{"mode":"shared"}'::jsonb, lifecycle='archived'
        WHERE id='chat_navigation_owner_1'`.execute(db);
      const snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      expect(snapshot.items.find(item => item.chat.id.endsWith('_1'))?.persistence).toBe('membership');
      expect(snapshot.items.find(item => item.chat.id.endsWith('_2'))?.persistence).toBe('personal');
      expect((await navigation.list(owner, { version: 1, limit: 1000, lifecycle: 'active' })).items).toHaveLength(1);
    });
    it("explicitly truncates a bounded window without per-item classification reads", async () => {
      const { db, navigation, count } = await setup(real);
      await seed(db, 1001);
      const snapshot = await navigation.list(owner, { version: 1, limit: 1000 });
      expect(snapshot.items).toHaveLength(1000);
      expect(snapshot.truncated).toBe(true);
      expect(count.value).toBe(1);
      await expect(navigation.list({ type: 'organization', ownerId: owner.ownerId }, { version: 1, limit: 1000 })).rejects.toThrow();
    });
  });
}
describe("authenticated navigation routes and recovery", () => {
  it("validates a strict versioned query, derives owner, and preserves legacy responses", async () => {
    const { db, service, count } = await setup();
    await seed(db, 1);
    const app = createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: owner.ownerId, source: 'jwt' }) });
    const response = await app.request('/api/chats/navigation');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const payload = await response.json();
    expect(CanonicalChatNavigationResponseSchema.parse(payload).items[0]?.chat.titleVersion).toBe(0);
    expect((await app.request('/api/chats/navigation?ownerId=outsider')).status).toBe(400);
    expect((await app.request('/api/chats/navigation?limit=1001')).status).toBe(400);
    expect((await app.request('/api/chats/navigation?version=2')).status).toBe(400);
    expect((await app.request('/api/chats/navigation?limit=1&limit=2')).status).toBe(400);
    expect(count.value).toBe(1);
    CanonicalChatListResponseSchema.parse(await (await app.request('/api/chats')).json());
    const denied = createCanonicalChatRoutes({ service, getPrincipal: () => { throw new MissingRequestPrincipalError(); } });
    expect((await denied.request('/api/chats/navigation')).status).toBe(401);
    expect(count.value).toBe(1);
  });
  it("paints navigation while authenticated event-stream recovery is pending, then observes its durable corrections", async () => {
    const { db, repository, navigation } = await setup();
    await seed(db, 1);
    let release!: () => void;
    let started!: () => void;
    const recoveryStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const frames: unknown[] = [];
    const stream = createCanonicalChatEventStream({ repository, reconcileOwner: async scope => {
      started();
      await gate;
      const current = await repository.get(scope, 'chat_navigation_owner_1');
      await repository.rename(scope, current!.chat.id, { title: 'Recovered', expectedTitleVersion: current!.chat.titleVersion ?? 0 });
    } });
    const opening = stream.open({ principal: { userId: owner.ownerId, source: 'jwt' },
      sink: { send(frame) { frames.push(frame); return true; }, close() {} } });
    await recoveryStarted;
    const reconcileActiveRuns = vi.fn(() => new Promise(() => {}));
    const service = createCanonicalChatService(repository, { navigation, orchestrator: { reconcileActiveRuns } as never });
    const snapshot = await service.navigation!(owner, { version: 1, limit: 1000 });
    expect(snapshot.items[0]?.chat.title).toBe('Title 1');
    expect(reconcileActiveRuns).not.toHaveBeenCalled();
    release();
    const session = await opening;
    expect(frames).toContainEqual(expect.objectContaining({ type: 'chat.event', event: expect.objectContaining({ eventType: 'chat.updated' }) }));
    expect((await service.navigation!(owner, { version: 1, limit: 1000 })).items[0]?.chat.title).toBe('Recovered');
    session.onClose();
    stream.shutdown();
  });
  it("reports missing classification dependencies as service failure instead of ordinary or unsupported", async () => {
    const { db, repository, navigation } = await setup();
    await seed(db, 1);
    const app = createCanonicalChatRoutes({ service: createCanonicalChatService(repository, { navigation }),
      getPrincipal: () => ({ userId: owner.ownerId, source: 'jwt' }) });
    await sql`DROP TABLE bot_chat_bindings`.execute(db);
    const response = await app.request('/api/chats/navigation');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('bot_chat_bindings');
  });
});
