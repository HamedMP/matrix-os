import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";

describe("browser approval transaction pool compatibility", () => {
  it("does not send server settings in the connection startup packet", async () => {
    const factory = vi.fn((_config: pg.PoolConfig) => ({ connect: vi.fn(), end: vi.fn(async () => {}), on: vi.fn() }));
    const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: factory as never });
    try {
      const config = factory.mock.calls[0]![0];
      expect(config).toMatchObject({ max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
      for (const key of ["options", "statement_timeout", "idle_in_transaction_session_timeout"]) {
        expect(config).not.toHaveProperty(key);
      }
    } finally { await lookup.close(); }
  });

  it("bounds the exact owner lookup inside one read-only transaction", async () => {
    const query = vi.fn(async (text: string, _parameters?: string[]) => ({ rows: text.startsWith("SELECT")
      ? [{ clerk_user_id: "owner", runtime_slot: "pr-1234", status: "running" }] : [] }));
    const release = vi.fn();
    const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
      connect: async () => ({ query, release }), end: async () => {}, on: vi.fn(),
    })) as never });
    try {
      expect(await lookup.resolveMachine("pr-1234", "pr-1234")).toEqual({ clerkUserId: "owner", runtimeSlot: "pr-1234", status: "running" });
      expect(query.mock.calls.map(([sql]) => sql)).toEqual([
        "BEGIN READ ONLY", "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '3s'",
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
        expect.stringContaining("activation_state='authorized' AND deleted_at IS NULL"), "COMMIT",
      ]);
      expect(query.mock.calls[4]![1]).toEqual(["pr-1234", "pr-1234"]);
      expect(release).toHaveBeenCalledExactlyOnceWith(false);
    } finally { await lookup.close(); }
  });

  it("destroys the connection on transaction failure without granting approval", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) throw new Error("synthetic database failure");
      return { rows: [] };
    });
    const release = vi.fn();
    const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
      connect: async () => ({ query, release }), end: async () => {}, on: vi.fn(),
    })) as never });
    try {
      await expect(lookup.resolveMachine("pr-1234", "pr-1234")).rejects.toThrow("synthetic database failure");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { await lookup.close(); }
  });

  it.each(["BEGIN READ ONLY", "SET LOCAL statement_timeout = '5s'", "COMMIT"])(
    "fails closed when %s fails, including after a matching row was read", async failure => {
      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === failure) throw new Error("synthetic transaction failure");
        return { rows: sql.startsWith("SELECT")
          ? [{ clerk_user_id: "owner", runtime_slot: "pr-1234", status: "running" }] : [] };
      });
      const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
        connect: async () => ({ query, release }), end: async () => {}, on: vi.fn(),
      })) as never });
      try {
        await expect(lookup.resolveMachine("pr-1234", "pr-1234")).rejects.toThrow("synthetic transaction failure");
        expect(release).toHaveBeenCalledExactlyOnceWith(true);
      } finally { await lookup.close(); }
    },
  );
});
