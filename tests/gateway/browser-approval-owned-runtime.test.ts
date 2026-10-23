import { describe, expect, it, vi } from "vitest";
import { createOwnedBrowserApprovalAuthority } from "../../packages/gateway/src/chat/browser-approval-owned-runtime.js";
describe("owned bounded browser authority lifecycle", () => {
  it("bounds physical pool work and closes only its owned pool exactly once even before first use", async () => {
    const end = vi.fn(async () => {});
    const factory = vi.fn(() => ({ connect: vi.fn(), end, on: vi.fn() }));
    const authority = createOwnedBrowserApprovalAuthority({ databaseUrl: "postgresql://synthetic.invalid/owner", poolFactory: factory,
      verifyDecision: async () => { throw new Error("no decision"); }, verifyRevoke: async () => { throw new Error("no revoke"); } });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ max: 2, connectionTimeoutMillis: 3000,
      statement_timeout: 5000, query_timeout: 5000, idle_in_transaction_session_timeout: 5000 }));
    const first = authority.close(); expect(authority.close()).toBe(first); await first;
    expect(end).toHaveBeenCalledOnce();
    await expect(authority.repository.activeGrant("owner", "chat")).rejects.toThrow("Browser approval unavailable");
  });
});
