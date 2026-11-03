import { describe, expect, it, vi } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import { QueuedChatRecovery } from "../../../packages/gateway/src/chat/queue-recovery.js";
import { listQueuedChatCandidates } from "../../../packages/gateway/src/chat/queued-chat-candidates.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { ChatOwner } from "../../../packages/gateway/src/chat/records.js";
const owner: ChatOwner = { type: "personal", ownerId: "user_page_owner" };
const ids = Array.from({ length: 20 }, (_, i) => `chat_page_${String(i).padStart(2, "0")}`);

describe("bounded fair queued Chat recovery", () => {
  it("wraps an empty tail with at most two reads and twenty dispatches", async () => {
    const recovery = new QueuedChatRecovery(), dispatch = vi.fn(async () => undefined);
    const list = vi.fn(async (_owner: ChatOwner, _limit: number, cursor?: string) => cursor ? [] : ids);
    await recovery.recover(owner, list, dispatch);
    list.mockClear(); dispatch.mockClear();
    await recovery.recover(owner, list, dispatch);
    expect(list.mock.calls).toEqual([[owner, 20, ids[19]], [owner, 20]]);
    expect(dispatch).toHaveBeenCalledTimes(20);
    recovery.close();
  });

  it("isolates cursor by owner type and account", async () => {
    const recovery = new QueuedChatRecovery();
    const list = vi.fn(async (_owner: ChatOwner, _limit: number, _cursor?: string) => ids);
    const dispatch = async () => undefined;
    await recovery.recover(owner, list, dispatch);
    const another: ChatOwner = { type: "personal", ownerId: "user_another_account" };
    const org: ChatOwner = { type: "organization", ownerId: owner.ownerId };
    await recovery.recover(another, list, dispatch);
    await recovery.recover(org, list, dispatch);
    await recovery.recover(owner, list, dispatch);
    expect(list.mock.calls.map(([scope, , cursor]) => [scope, cursor])).toEqual([
      [owner, undefined], [another, undefined], [org, undefined], [owner, ids[19]],
    ]);
    recovery.close();
  });

  it("evicts the least recently scanned owner after sixty-four cursors", async () => {
    const recovery = new QueuedChatRecovery();
    const list = vi.fn(async (_owner: ChatOwner, _limit: number, _cursor?: string) => ids);
    const dispatch = async () => undefined;
    const owners = Array.from({ length: 65 }, (_, i): ChatOwner => ({ type: "personal", ownerId: `user_page_${i}` }));
    for (const scope of owners.slice(0, 64)) await recovery.recover(scope, list, dispatch);
    await recovery.recover(owners[0]!, list, dispatch); // refresh first owner
    await recovery.recover(owners[64]!, list, dispatch);
    await recovery.recover(owners[0]!, list, dispatch);
    expect(list.mock.lastCall?.[2]).toBe(ids[19]);
    await recovery.recover(owners[1]!, list, dispatch);
    expect(list.mock.lastCall?.[2]).toBeUndefined();
    recovery.close();
  });

  it("propagates read/dispatch failures without skipping an unexamined Chat", async () => {
    const recovery = new QueuedChatRecovery(), failure = new Error("Synthetic read failure");
    const list = vi.fn(async (_owner: ChatOwner, _limit: number, _cursor?: string): Promise<string[]> => { throw failure; });
    const dispatch = vi.fn(async () => undefined);
    await expect(recovery.recover(owner, list, dispatch)).rejects.toBe(failure);
    expect(dispatch).not.toHaveBeenCalled();
    list.mockResolvedValue(ids);
    dispatch.mockRejectedValueOnce(failure);
    await expect(recovery.recover(owner, list, dispatch)).rejects.toBe(failure);
    await recovery.recover(owner, list, dispatch);
    expect(list.mock.lastCall?.[2]).toBeUndefined();
    recovery.close();
  });

  it("does not dispatch or retain new scan work after shutdown while a read is pending", async () => {
    const recovery = new QueuedChatRecovery();
    let settle!: (ids: string[]) => void;
    const list = vi.fn(() => new Promise<string[]>(resolve => { settle = resolve; }));
    const dispatch = vi.fn(async () => undefined);
    const pending = recovery.recover(owner, list, dispatch);
    recovery.close(); settle(ids); await pending;
    await recovery.recover(owner, list, dispatch);
    expect(list).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("queued candidate SQL without PostgreSQL", () => {
  it("scopes and validates a parameterized cursor before bounded LIMIT without Bot table coupling", async () => {
    const queries: CompiledQuery[] = [];
    class InertDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        return { async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          if (queries.length >= 4) throw new Error("Capture cap");
          queries.push(query); return { rows: [] };
        }, async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("No streaming"); } };
      }
    }
    const db = new Kysely<ChatDatabase>({ dialect: {
      createAdapter: () => new PostgresAdapter(), createDriver: () => new InertDriver(),
      createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
    } });
    try {
      await listQueuedChatCandidates(db, owner, 100, ids[19]);
      expect(queries[0]!.parameters).toEqual(["queued", "personal", owner.ownerId, ids[19], 20]);
      expect(queries[0]!.sql).toContain('"chat"."owner_type" = $2');
      expect(queries[0]!.sql).toContain('"chat"."owner_id" = $3');
      expect(queries[0]!.sql).toContain('"queued"."chat_id" > $4');
      expect(queries[0]!.sql).toContain('group by "queued"."chat_id" order by "queued"."chat_id" limit $5');
      expect(queries[0]!.sql).not.toContain("bot_");
      await expect(listQueuedChatCandidates(db, owner, 20, "../invalid cursor")).rejects.toThrow();
      expect(queries).toHaveLength(1);
    } finally { await db.destroy(); }
  });
});
