import { describe, it, expect, vi } from "vitest";
import { createMockHetznerClient } from "./customer-vps-fixtures.js";
import { useCustomerVpsFixture } from "./customer-vps-service-test-helper.js";
import { previewDeletionProof, previewScopeDeletionProof } from "../../packages/platform/src/customer-vps-preview-deletion.js";
const deleted = {
  machineId: "machine-12", clerkUserId: "user_team", provisioningClass: "preview",
  handle: "pr-12", status: "deleted", deletedAt: "2026-10-19", hetznerServerId: 42,
} as any;
function fixture({ pending = false, queue = [], rows = [] }: any = {}) {
  const where = vi.fn();
  const db = { ready: Promise.resolve(), executor: { selectFrom: (table: string) => {
    const query: any = {
      select: () => query, limit: () => query,
      where: (...args: any[]) => { where(table, ...args); return query; },
      executeTakeFirst: async () => pending ? { job_id: "pending" } : undefined,
      execute: async () => table === "user_machines" ? rows : queue,
    };
    return query;
  } } } as any;
  const provider = { getServer: vi.fn().mockResolvedValue(null), listServersByLabel: vi.fn().mockResolvedValue([]) };
  return { db, provider, where };
}
describe("preview physical deletion proof", () => {
  it("holds known servers until provider absence is confirmed", async () => {
    const f = fixture();
    f.provider.getServer.mockResolvedValueOnce({ id: 42 } as any);
    expect(await previewDeletionProof(deleted, f.provider, f.db)).toEqual({ previewDeletionConfirmed: false });
    expect(await previewDeletionProof(deleted, f.provider, f.db)).toEqual({ previewDeletionConfirmed: true });
  });
  it("checks labels even when an ambiguous create left no persisted server ID", async () => {
    const f = fixture();
    f.provider.listServersByLabel.mockResolvedValueOnce([{ id: 88 }] as any);
    const row = { ...deleted, hetznerServerId: null };
    expect(await previewDeletionProof(row, f.provider, f.db)).toEqual({ previewDeletionConfirmed: false });
    expect(await previewDeletionProof(row, f.provider, f.db)).toEqual({ previewDeletionConfirmed: true });
    expect(f.provider.listServersByLabel).toHaveBeenCalledWith("machine_id=machine-12");
  });
  it("holds while a platform job can create a server after GitHub cancellation", async () => {
    const f = fixture({ pending: true });
    expect(await previewDeletionProof(deleted, f.provider, f.db)).toEqual({ previewDeletionConfirmed: false });
    expect(f.provider.listServersByLabel).not.toHaveBeenCalled();
  });
  it("checks queued extra IDs even if their deletion was marked complete", async () => {
    const f = fixture({ queue: [{ provider_server_id: 77 }] });
    f.provider.getServer.mockImplementation(async (id: number) => id === 77 ? { id } as any : null);
    expect(await previewDeletionProof(deleted, f.provider, f.db)).toEqual({ previewDeletionConfirmed: false });
    expect(f.provider.getServer).toHaveBeenCalledWith(77);
  });
  it("fails closed on missing inventory, provider failure, and oversized cleanup history", async () => {
    const f = fixture();
    expect(await previewDeletionProof(deleted, { getServer: f.provider.getServer }, f.db)).toEqual({ previewDeletionConfirmed: false });
    f.provider.listServersByLabel.mockRejectedValueOnce(new Error("timeout"));
    await expect(previewDeletionProof(deleted, f.provider, f.db)).rejects.toThrow("timeout");
    const large = fixture({ queue: Array.from({ length: 101 }, () => ({ provider_server_id: 77 })) });
    expect(await previewDeletionProof(deleted, large.provider, large.db)).toEqual({ previewDeletionConfirmed: false });
  });
  it("does not probe customer or live runtimes", async () => {
    const f = fixture();
    for (const row of [{ ...deleted, provisioningClass: "customer" }, { ...deleted, deletedAt: null }, { ...deleted, handle: "private-pr-12" }]) {
      expect(await previewDeletionProof(row, f.provider, f.db)).toEqual({});
    }
    expect(f.provider.getServer).not.toHaveBeenCalled();
  });
  it("recovers tombstones by owner and PR without relying on active fleet inventory", async () => {
    const row = { machine_id: deleted.machineId, provisioning_class: "preview", handle: "pr-12", deleted_at: deleted.deletedAt, status: "deleted", hetzner_server_id: 42 };
    const f = fixture({ rows: [row] });
    expect(await previewScopeDeletionProof(f.db, f.provider, { owner: "user_team", pr: 12 })).toEqual({ confirmed: true });
    expect(f.where).toHaveBeenCalledWith("user_machines", "clerk_user_id", "=", "user_team");
    expect(f.where).toHaveBeenCalledWith("user_machines", "handle", "=", "pr-12");
    expect(f.where).toHaveBeenCalledWith("user_machines", "provisioning_class", "=", "preview");
    expect(f.where).toHaveBeenCalledWith("user_machines", "runtime_slot", "in", ["pr-12", "preview"]);
    const live = fixture({ rows: [{ ...row, deleted_at: null }] });
    expect(await previewScopeDeletionProof(live.db, live.provider, { owner: "user_team", pr: 12 })).toEqual({ confirmed: false });
  });
  it("bounds scope history, validates identity, and confirms an empty durable scope", async () => {
    const f = fixture();
    expect(await previewScopeDeletionProof(f.db, f.provider, { owner: "user_team", pr: 12 })).toEqual({ confirmed: true });
    await expect(previewScopeDeletionProof(f.db, f.provider, { owner: "other", pr: 12 })).rejects.toThrow();
    const large = fixture({ rows: Array.from({ length: 101 }, () => ({})) });
    expect(await previewScopeDeletionProof(large.db, large.provider, { owner: "user_team", pr: 12 })).toEqual({ confirmed: false });
  });
});

describe("preview cleanup service proof", () => {
  const { createService } = useCustomerVpsFixture();
  it("recovers an externally deleted preview while provider cleanup retries", async () => {
    const { service, hetzner } = createService({ hetzner: createMockHetznerClient({
      deleteServer: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    }) });
    const preview = await service.provisionPreview({ clerkUserId: "user_team", handle: "pr-12", runtimeSlot: "pr-12" });
    expect(await service.previewCleanupStatus({ owner: "user_other", pr: 12 })).toEqual({ confirmed: true });
    await service.delete(preview.machineId);
    expect(await service.previewCleanupStatus({ owner: "user_team", pr: 12 })).toEqual({ confirmed: false });
    vi.mocked(hetzner.getServer).mockResolvedValue(null);
    expect(await service.previewCleanupStatus({ owner: "user_team", pr: 12 })).toEqual({ confirmed: true });
  });
});
