import { describe, expect, it, vi } from "vitest";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";
describe("owned browser approval machine lookup", () => {
  it("uses its own bounded server-timeout pool and releases it on shutdown", async () => {
    const release = vi.fn(), end = vi.fn(async () => {});
    const query = vi.fn(async (_statement: string, _parameters: unknown[]) => ({ rows: [{ clerk_user_id: "owner", runtime_slot: "pr-1234", status: "running" }] }));
    const factory = vi.fn(() => ({ connect: vi.fn(async () => ({ query, release })), end, on: vi.fn() }));
    const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: factory as never });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 }));
    expect(await lookup.resolveMachine("pr-1234", "pr-1234")).toEqual({ clerkUserId: "owner", runtimeSlot: "pr-1234", status: "running" });
    expect(query.mock.calls[4]?.[1]).toEqual(["pr-1234", "pr-1234"]);
    await lookup.close(); expect(end).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    await expect(lookup.resolveMachine("pr-1234", "pr-1234")).rejects.toThrow("Browser approval unavailable");
  });
  it("physically closes an in-flight query so the verification admission is released", async () => {
    let rejectQuery!: (error: Error) => void;
    const query = vi.fn((sql: string) => sql.startsWith("SELECT")
      ? new Promise<never>((_resolve, reject) => { rejectQuery = reject; })
      : Promise.resolve({ rows: [] }));
    const release = vi.fn((destroy: boolean) => { if (destroy) rejectQuery(new Error("synthetic closed connection")); });
    const end = vi.fn(async () => {});
    const lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
      connect: async () => ({ query, release }), end, on: vi.fn(),
    })) as never });
    const pending = lookup.resolveMachine("pr-1234", "pr-1234").catch(error => error);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(5)); await lookup.close();
    expect(await pending).toBeInstanceOf(Error); expect(release).toHaveBeenCalledExactlyOnceWith(true); expect(end).toHaveBeenCalledOnce();
  });
});
