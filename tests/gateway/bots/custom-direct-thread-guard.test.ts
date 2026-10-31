/** Real SQL compiler plus inert synthetic rows: no PostgreSQL, network or model. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import { BotEntryError, createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { ChatRecord } from "../../../packages/gateway/src/chat/records.js";
import type { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { admitCanonicalRetry } from "../../../packages/gateway/src/chat/retry-admission.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import type { ChatRunContext } from "@matrix-os/contracts";
import { admitCanonicalTurn } from "../../../packages/gateway/src/chat/turn-admission.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";

const OWNER = "user_guard_owner", CHAT = "chat_guard_fixture", BOT = "bot_guard_fixture";
const NOW = "2026-09-27T12:00:00.000Z";
const owner = { type: "personal" as const, ownerId: OWNER };
type Row = { owner_id: string; chat_id: string; bot_id: string; kind: "direct" | "group" | "thread";
  removed_at: string | null; created_at: string; project_id?: string };
const row = (kind: Row["kind"], extra: Partial<Row> = {}): Row => ({
  owner_id: OWNER, chat_id: CHAT, bot_id: BOT, kind, removed_at: null, created_at: NOW, ...extra,
});
let database: Kysely<ChatDatabase> | undefined;
afterEach(async () => { await database?.destroy(); database = undefined; });

function fixture(rows: readonly Row[] = [], failure?: Error) {
  const queries: CompiledQuery[] = [];
  class InertDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          if (queries.length >= 128) throw new Error("Synthetic query capture limit");
          queries.push(query);
          if (failure) throw failure;
          if (!query.sql.startsWith("select ")) throw new Error("No writes allowed in inert lookup fixture");
          const [ownerId, chatId, kind] = query.parameters;
          const live = rows.filter(binding => binding.owner_id === ownerId && binding.chat_id === chatId && binding.removed_at === null);
          // Explicit synthetic results; assertions also inspect compiled SQL/parameters.
          const selected = kind === "thread" && query.sql.includes('"kind" =')
            ? live.filter(binding => binding.kind === "thread").slice(0, 1)
            : live.slice(0, 16);
          return { rows: selected as unknown as R[] };
        },
        async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("No streaming in inert fixture"); },
      };
    }
  }
  database = new Kysely<ChatDatabase>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new InertDriver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  const record: ChatRecord = { chat: { id: CHAT, ownerScope: owner, title: "Synthetic retained Chat", attention: "none",
    messageCount: 1, revision: 0, lifecycle: "active", createdAt: NOW, updatedAt: NOW } };
  const persist = vi.fn(async () => { throw new Error("Unexpected run persistence"); });
  const persistRetry = vi.fn<ChatRepository["admitRetry"]>(async () => { throw new Error("Unexpected retry persistence"); });
  const retryContext = vi.fn<ChatRepository["getTurnRunContext"]>(async () => null);
  const queuedChats = vi.fn<ChatRepository["listQueuedChatIds"]>(async () => []);
  const claimQueued = vi.fn<ChatRepository["claimNextQueuedTurn"]>(async () => null);
  const repository = { kysely: database, withTransaction: vi.fn(async () => { throw new Error("No fixture transactions"); }),
    get: vi.fn(async () => record), getDetailPage: vi.fn(async () => ({ record, messages: [], runs: [], activities: [] })),
    findTurnAdmission: vi.fn(async () => null), getLatestAdapterStateForChat: vi.fn(async () => null),
    findRetryAdmission: vi.fn(async () => null), getTurnRunContext: retryContext, admitRetry: persistRetry,
    getAdapterState: vi.fn(async () => null), hasRetryRequest: vi.fn(async () => false),
    listActiveRunContexts: vi.fn(async () => []), listQueuedChatIds: queuedChats, claimNextQueuedTurn: claimQueued,
    admitTurn: persist, finishRun: vi.fn(async () => { throw new Error("No existing run to finish"); }),
  } as unknown as ChatRepository;
  const agents = { get: vi.fn(async () => null) };
  return { botChats: createCustomBotChats({ chats: repository, agents }), queries, repository, agents, persist,
    persistRetry, retryContext, queuedChats, claimQueued, record };
}

describe("unsupported retained thread lookup guard without PostgreSQL", () => {
  it.each(["thread only", "past sixteen groups", "mixed direct and thread"] as const)("refuses %s before ordinary fallback", async scenario => {
    const prefix = scenario === "past sixteen groups" ? Array.from({ length: 16 }, (_, i) => row("group", { bot_id: `bot_group_${i}` }))
      : scenario === "mixed direct and thread" ? [row("direct")] : [];
    const { botChats, queries } = fixture([...prefix, row("thread", { bot_id: "bot_thread", project_id: "proj_saved" })]);
    const outcome = await botChats.directBot(owner, CHAT).then(value => ({ value }), error => ({ error }));
    expect(outcome).toEqual({ error: new BotEntryError("unavailable") });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.parameters).toEqual([OWNER, CHAT, "thread", 1]);
    expect(queries[0]!.sql).toContain('"owner_id" = $1');
    expect(queries[0]!.sql).toContain('"chat_id" = $2');
    expect(queries[0]!.sql).toContain('"kind" = $3');
    expect(queries[0]!.sql).toContain('"removed_at" is null');
    expect(queries[0]!.sql).not.toContain("project_id");
  });

  it.each([
    { name: "ordinary unbound Chat", rows: [], expected: null },
    { name: "direct Bot Chat", rows: [row("direct")], expected: BOT },
    { name: "group binding", rows: [row("group")], expected: null },
    { name: "removed thread", rows: [row("thread", { removed_at: NOW })], expected: null },
    { name: "another account's thread", rows: [row("thread", { owner_id: "user_other_account" })], expected: null },
    { name: "another Chat's thread", rows: [row("thread", { chat_id: "chat_other" })], expected: null },
  ])("preserves $name lookup", async ({ rows, expected }) => {
    const { botChats, queries } = fixture(rows);
    expect(await botChats.directBot(owner, CHAT)).toBe(expected);
    expect(queries.every(query => query.parameters[0] === OWNER && query.parameters[1] === CHAT)).toBe(true);
  });

  it("does not query personal bindings for an organization scope", async () => {
    const { botChats, queries } = fixture([row("thread")]);
    expect(await botChats.directBot({ type: "organization", ownerId: OWNER }, CHAT)).toBeNull();
    expect(queries).toEqual([]);
  });

  it("propagates binding storage failure instead of allowing ordinary fallback", async () => {
    const error = new Error("Synthetic database unavailable");
    const { botChats, queries } = fixture([], error);
    await expect(botChats.directBot(owner, CHAT)).rejects.toBe(error);
    expect(queries).toHaveLength(1);
  });

  it.each(["supervised", "full_access"] as const)("stops canonical %s admission before catalog, persistence and dispatch", async permissionMode => {
    const { botChats, repository, agents, persist } = fixture([row("thread", { project_id: "proj_saved" })]);
    const context = new ChatAgentContext({ repository, agents, botChats, enabled: () => true });
    const catalog = vi.fn(async () => { throw new Error("Unexpected provider catalog access"); });
    const dispatch = vi.fn(async () => undefined);
    const outcome = await admitCanonicalTurn({ repository, agentContext: context,
      catalog: { getCatalog: catalog }, adapters: new CanonicalChatProviderRegistry([]),
      assertOpen: () => undefined, assertPersonalExecutionAllowed: async () => undefined,
      reconcileActiveRuns: async () => 0, reservePendingDispatch: () => undefined, releasePendingDispatch: () => undefined,
      atCapacity: () => false, hasStoppingExecution: () => false, startDispatch: dispatch,
    }, { userId: OWNER, source: "jwt" }, owner, CHAT, { clientRequestId: `req_guard_${permissionMode}`, baseRevision: 0,
      selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default",
      permissionMode, parts: [{ type: "text", text: "Synthetic blocked request" }],
    }).then(value => ({ value }), error => ({ error }));
    expect(outcome).toMatchObject({ error: { status: 503, safeError: { code: "resource_unavailable", retryable: false, recoveryActions: [] } } });
    expect({ catalogReads: catalog.mock.calls.length, runWrites: persist.mock.calls.length, dispatches: dispatch.mock.calls.length })
      .toEqual({ catalogReads: 0, runWrites: 0, dispatches: 0 });
  });
});

const retainedContexts: Array<{ name: string; context: ChatRunContext | undefined }> = [
  { name: "missing", context: undefined },
  { name: "history-only", context: { version: 1, requestHash: "a".repeat(64), chats: [],
    history: { chatId: CHAT, title: "Synthetic history", throughSeq: 1, text: "Retained", truncated: false } } },
];

describe("retained thread revalidation and recovered entry boundaries", () => {
  it.each(retainedContexts)("refuses $name run context before provider revalidation can return", async ({ context }) => {
    const { botChats, repository, agents } = fixture([row("thread")]);
    const validator = new ChatAgentContext({ repository, agents, botChats, enabled: () => true });
    await expect(validator.revalidate(owner, CHAT, context)).rejects.toEqual(new BotEntryError("unavailable"));
  });

  it.each(retainedContexts)("retains ordinary Chat revalidation with $name context", async ({ context }) => {
    const { botChats, repository, agents } = fixture();
    const validator = new ChatAgentContext({ repository, agents, botChats, enabled: () => true });
    await expect(validator.revalidate(owner, CHAT, context)).resolves.toBeUndefined();
  });

  it.each(retainedContexts)("rejects historical Retry with $name context before catalog, new run or dispatch", async ({ context }) => {
    const f = fixture([row("thread")]);
    f.retryContext.mockResolvedValue({ chat: f.record, turn: { id: "cturn_old", baseMessageSeq: 1 },
      message: { parts: [{ type: "text", text: "Synthetic old request" }] }, latestRun: {
        id: "run_old", driverKind: "matrix_pi", instanceId: "matrix_pi_default", selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
        interactionMode: "default", permissionMode: "full_access", context,
      },
    } as unknown as NonNullable<Awaited<ReturnType<ChatRepository["getTurnRunContext"]>>>);
    const validator = new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true });
    const catalog = vi.fn(async () => { throw new Error("Unexpected retry catalog access"); });
    const dispatch = vi.fn(async () => undefined);
    const outcome = await admitCanonicalRetry({ repository: f.repository, agentContext: validator,
      catalog: { getCatalog: catalog }, adapters: new CanonicalChatProviderRegistry([]),
      assertOpen: () => undefined, assertPersonalExecutionAllowed: async () => undefined,
      reconcileActiveRuns: async () => 0, reservePendingDispatch: () => undefined, releasePendingDispatch: () => undefined,
      atCapacity: () => false, hasStoppingExecution: () => false, startDispatch: dispatch,
    }, { userId: OWNER, source: "jwt" }, owner, CHAT, "cturn_old", { clientRequestId: "req_retry_guard", baseRevision: 0 })
      .then(value => ({ value }), error => ({ error }));
    expect(outcome).toMatchObject({ error: { status: 503, safeError: { code: "resource_unavailable", retryable: false, recoveryActions: [] } } });
    expect({ catalogs: catalog.mock.calls.length, runWrites: f.persistRetry.mock.calls.length, dispatches: dispatch.mock.calls.length })
      .toEqual({ catalogs: 0, runWrites: 0, dispatches: 0 });
  });

  it.each([true, false])("recovered queue thread=%s is fenced before claim while ordinary queues still check for work", async isThread => {
    const f = fixture(isThread ? [row("thread")] : []);
    f.queuedChats.mockResolvedValue([CHAT]);
    const catalog = vi.fn(async () => { throw new Error("No provider needed before queue claim"); });
    const canonical = new CanonicalChatOrchestrator({ repository: f.repository,
      catalog: { getCatalog: catalog }, adapters: new CanonicalChatProviderRegistry([]),
      agentContext: new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true }),
    });
    try {
      const outcome = await canonical.reconcileActiveRuns(owner).then(value => ({ value }), error => ({ error }));
      expect({ outcome, claims: f.claimQueued.mock.calls.length, writes: f.persist.mock.calls.length, catalogs: catalog.mock.calls.length })
        .toEqual({ outcome: { value: 0 }, claims: isThread ? 0 : 1, writes: 0, catalogs: 0 });
    } finally { await canonical.close(); }
  });
});


describe("blocked thread queue isolation", () => {
  it("skips only the thread Chat and continues an ordinary Chat queued after it", async () => {
    const f = fixture([row("thread")]);
    f.queuedChats.mockResolvedValue([CHAT, "chat_ordinary"]);
    const canonical = new CanonicalChatOrchestrator({ repository: f.repository,
      catalog: { getCatalog: async () => { throw new Error("No catalog before empty queue claim"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      agentContext: new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true }),
    });
    try {
      const outcome = await canonical.reconcileActiveRuns(owner).then(value => ({ value }), error => ({ error }));
      expect({ outcome, claimedChats: f.claimQueued.mock.calls.map(([, input]) => input.chatId) })
        .toEqual({ outcome: { value: 0 }, claimedChats: ["chat_ordinary"] });
    } finally { await canonical.close(); }
  });

  it.each(["Turn", "Retry"] as const)("lets an ordinary %s reach its catalog while this owner has a blocked thread queue", async entry => {
    const f = fixture([row("thread")]);
    f.queuedChats.mockResolvedValue([CHAT]);
    f.record.chat.id = "chat_ordinary";
    f.retryContext.mockResolvedValue({ chat: f.record, turn: { id: "cturn_ordinary", baseMessageSeq: 1 },
      message: { parts: [{ type: "text", text: "Synthetic ordinary retry" }] }, latestRun: {
        id: "run_ordinary_old", driverKind: "matrix_pi", instanceId: "matrix_pi_default",
        selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "full_access",
      },
    } as unknown as NonNullable<Awaited<ReturnType<ChatRepository["getTurnRunContext"]>>>);
    const marker = new Error("Synthetic ordinary catalog boundary");
    const catalog = vi.fn(async () => { throw marker; });
    const canonical = new CanonicalChatOrchestrator({ repository: f.repository,
      catalog: { getCatalog: catalog }, adapters: new CanonicalChatProviderRegistry([]),
      agentContext: new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true }),
    });
    try {
      const principal = { userId: OWNER, source: "jwt" as const };
      const pending = entry === "Turn"
        ? canonical.admitTurn(principal, owner, "chat_ordinary", { clientRequestId: "req_ordinary_guard", baseRevision: 0,
          selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default",
          permissionMode: "full_access", parts: [{ type: "text", text: "Synthetic ordinary request" }] })
        : canonical.retryTurn(principal, owner, "chat_ordinary", "cturn_ordinary", { clientRequestId: "req_ordinary_retry", baseRevision: 0 });
      const outcome = await pending.then(value => ({ value }), error => ({ error }));
      expect({ outcome, catalogs: catalog.mock.calls.length, queueClaims: f.claimQueued.mock.calls.length,
        runWrites: f.persist.mock.calls.length, retryWrites: f.persistRetry.mock.calls.length })
        .toEqual({ outcome: { error: marker }, catalogs: 1, queueClaims: 0, runWrites: 0, retryWrites: 0 });
    } finally { await canonical.close(); }
  });

  it("propagates an unrelated queue storage error even if its fields resemble a thread refusal", async () => {
    const failure = Object.assign(new Error("Synthetic queue storage unavailable"), { name: "BotEntryError", code: "unavailable" });
    const f = fixture([], failure);
    f.queuedChats.mockResolvedValue([CHAT]);
    const canonical = new CanonicalChatOrchestrator({ repository: f.repository,
      catalog: { getCatalog: async () => { throw new Error("No catalog during storage failure"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      agentContext: new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true }),
    });
    try {
      await expect(canonical.reconcileActiveRuns(owner)).rejects.toBe(failure);
      expect(f.claimQueued).not.toHaveBeenCalled();
    } finally { await canonical.close(); }
  });
});


describe("bounded queue recovery pagination", () => {
  it("reaches ordinary Chat 21 after twenty retained thread queues on the next recovery pass", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `chat_page_${String(index).padStart(2, "0")}`);
    const f = fixture(ids.slice(0, 20).map(chat_id => row("thread", { chat_id })));
    f.queuedChats.mockImplementation(async (_scope, limit = 20, afterChatId) =>
      ids.filter(id => !afterChatId || id > afterChatId).slice(0, limit));
    const canonical = new CanonicalChatOrchestrator({ repository: f.repository,
      catalog: { getCatalog: async () => { throw new Error("No catalog before empty queue claim"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      agentContext: new ChatAgentContext({ repository: f.repository, agents: f.agents, botChats: f.botChats, enabled: () => true }),
    });
    try {
      await expect(canonical.reconcileActiveRuns(owner)).resolves.toBe(0);
      expect(f.claimQueued).not.toHaveBeenCalled();
      await expect(canonical.reconcileActiveRuns(owner)).resolves.toBe(0);
      expect(f.claimQueued.mock.calls.map(([, input]) => input.chatId)).toEqual([ids[20]]);
      expect(f.queuedChats).toHaveBeenNthCalledWith(2, owner, 20, ids[19]);
      expect(f.persist).not.toHaveBeenCalled();
    } finally { await canonical.close(); }
  });
});
