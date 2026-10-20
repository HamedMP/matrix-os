import { describe, it, expect } from "vitest";
import { fixture, pr, head } from "./preview-review-fixture";
describe("actual preview reconciliation across GitHub and fleet boundaries", () => {
  it("pauses new reservations for unreserved legacy cleanup and recovers only after physical proof", async () => {
    const f = fixture([pr(2)]);
    const legacy = f.machine(1, { status: "deleted", deletedAt: "2026-10-19", previewDeletionConfirmed: false });
    await f.reconcile();
    expect(f.leases).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.comments.get(2).body).toContain("physical cleanup");
    legacy.previewDeletionConfirmed = true;
    await f.reconcile();
    expect(f.leases).toHaveLength(1);
    expect(f.dispatches.map((d: any) => d.inputs.pr)).toEqual(["2"]);
  });
  it("reserves before dispatch, caps sixteen, and reports queued owners", async () => {
    const f = fixture(Array.from({ length: 17 }, (_, i) => pr(i + 1)));
    await f.reconcile();
    expect(f.leases).toHaveLength(16);
    expect(f.dispatches).toHaveLength(16);
    expect(f.comments.get(17).body).toContain("Queued");
    expect(f.comments.get(1).body).toContain("@author-17");
    await f.reconcile();
    expect(f.dispatches).toHaveLength(16);
  });
  it("drains active unreserved manual previews before admitting new work", async () => {
    const f = fixture();
    const row = f.reserve();
    const legacy = f.web(row, 101, {
      display_title: "Preview VPS",
      status: "in_progress",
      conclusion: null,
    });
    f.leases.splice(0);
    await f.reconcile();
    expect(f.dispatches).toHaveLength(0);
    expect(f.comments.get(1).body).toContain("Legacy preview jobs draining");
    legacy.status = "completed";
    await f.reconcile();
    expect(f.dispatches).toHaveLength(1);
  });
  it.each([0, 15])("retires an expired legacy runtime before fresh admission with %i other slots", async (otherSlots) => {
    const request = pr(1), f = fixture([request]);
    const legacy = f.machine(1, { provisionedAt: "2026-10-10T09:00:00Z" });
    for (let index = 0; index < otherSlots; index++) f.machine(index + 2);
    let confirmed = false, removed = 0;
    f.platform.deletionConfirmed = async () => confirmed;
    f.platform.remove = async (target: any) => {
      expect(target).toBe(legacy); removed++;
      Object.assign(legacy, { status: "deleted", deletedAt: "2026-10-19T10:00:00Z", previewDeletionConfirmed: false });
      return { deleted: true };
    };
    await f.reconcile();
    expect(removed).toBe(1);
    expect(f.leases).toHaveLength(0); expect(f.dispatches).toHaveLength(0);
    await f.reconcile();
    expect(removed).toBe(1); expect(f.leases).toHaveLength(0);
    expect(request.labels).toEqual([{ name: "preview" }]);
    confirmed = true; legacy.previewDeletionConfirmed = true;
    await f.reconcile();
    expect(f.leases).toHaveLength(1);
    expect(f.leases[0].payload.expiresAt).toBe("2026-10-22T10:00:00.000Z");
    expect(f.dispatches.map((row: any) => row.inputs.pr)).toEqual(["1"]);
    expect(request.labels).toEqual([{ name: "preview" }]);
  });
  it.each(["foreign", "ambiguous", "leased"])("does not retire a %s legacy target outside cleanup authority", async (mode) => {
    const f = fixture();
    f.machine(1, { provisionedAt: "2026-10-10T09:00:00Z", ...(mode === "foreign" ? { clerkUserId: "user_other" } : {}) });
    if (mode === "ambiguous") f.machine(1, { provisionedAt: "2026-10-10T09:00:00Z" });
    if (mode === "leased") f.reserve();
    f.platform.remove = async () => { throw new Error("Protected legacy runtime must not be removed"); };
    await expect(f.reconcile()).resolves.toBeDefined();
    expect(f.machines.every(machine => machine.deletedAt == null)).toBe(true);
  });
  it("bounds an adopted runtime expiry by the existing reaper lifetime", async () => {
    const f = fixture();
    f.machine(1, { provisionedAt: "2026-10-17T10:00:00Z" });
    await f.reconcile();
    expect(f.leases[0].payload.expiresAt).toBe("2026-10-20T10:00:00.000Z");
  });
  it("reports missing completed desktop artifacts as unavailable, not in progress", async () => {
    const f = fixture(),
      r = f.reserve();
    r.payload.desktop = true;
    f.web(r);
    f.machine();
    f.web(r, 102, {
      path: ".github/workflows/preview-desktop.yml",
      display_title: `preview-desktop-v1 pr=1 head=${head} lease=${r.id}`,
    });
    await f.reconcile();
    expect(f.comments.get(1).body).toContain(
      "Desktop downloads unavailable/expired",
    );
    expect(f.comments.get(1).body).not.toContain("Ready for review");
  });
  it("does not retry an ambiguous dispatch or release its occupied slot", async () => {
    const f = fixture();
    f.failDispatch();
    await f.reconcile();
    await f.reconcile();
    expect(f.dispatches).toHaveLength(1);
    expect(f.leases[0].state).toBe("error");
    expect(f.comments.get(1).body).toContain("uncertain");
  });
  it("stops duplicate dispatches before deleting and releasing a closed PR slot", async () => {
    const p = pr(1, { state: "closed" }),
      f = fixture([p]);
    const row = f.reserve();
    f.web(row, 101, { status: "in_progress", conclusion: null });
    f.web(row, 102, { status: "in_progress", conclusion: null });
    f.machine();
    await f.reconcile();
    expect(f.cancelled).toEqual([101, 102]);
    expect(f.machines).toHaveLength(1);
    expect(f.comments.get(1).body).not.toContain("[Open preview]");
    f.runs.forEach((r) => {
      r.status = "completed";
      r.conclusion = "cancelled";
    });
    await f.reconcile();
    expect(f.machines).toHaveLength(0);
    expect(f.leases[0].state).toBe("inactive");
    expect(f.privateDeletes).toEqual([1]);
  });
  it("retains deleted machine identity while provider cleanup is pending", async () => {
    const f = fixture([pr(1, { state: "closed" })]),
      r = f.reserve();
    f.web(r);
    f.machine();
    let confirmed = false;
    f.platform.deletionConfirmed = async () => confirmed;
    await f.reconcile();
    expect(f.machines).toHaveLength(0);
    expect(r.state).toBe("in_progress");
    expect(r.description).toContain("physical preview cleanup confirmation");
    await f.reconcile();
    expect(r.state).not.toBe("inactive");
    confirmed = true;
    await f.reconcile();
    expect(r.state).toBe("inactive");
  });
  it("clears ready links and holds capacity on deletion failure", async () => {
    const p = pr(1, { state: "closed" }),
      f = fixture([p]);
    const r = f.reserve();
    f.web(r);
    f.machine();
    f.failDeletion();
    await f.reconcile();
    expect(f.leases[0].state).toBe("error");
    expect(f.comments.get(1).body).toContain("capacity held");
    expect(f.comments.get(1).body).not.toContain("[Open preview]");
  });
  it("expires a labeled PR without immediately readmitting it ahead of waiting work", async () => {
    const f = fixture([pr(1), pr(2)]),
      r = f.reserve(1);
    r.payload.expiresAt = "2026-10-18T09:00:00Z";
    f.web(r);
    f.machine();
    await f.reconcile();
    expect(f.dispatches.map((x) => x.inputs.pr)).toEqual(["2"]);
    expect(f.leases[0].state).toBe("inactive");
  });
  it("recognizes a correctly installed build across UTC midnight", async () => {
    const f = fixture(),
      r = f.reserve();
    f.web(r);
    f.machine();
    await f.reconcile();
    expect(f.comments.get(1).body).toContain("Ready for review");
    expect(f.comments.get(1).body).toContain("[Open preview]");
  });
  it("never deletes a different owner runtime with the same preview-shaped handle", async () => {
    const f = fixture([pr(1, { state: "closed" })]),
      r = f.reserve();
    f.web(r);
    f.machine(1, { clerkUserId: "user_other" });
    await f.reconcile();
    expect(f.machines).toHaveLength(1);
    expect(f.leases[0].state).toBe("error");
  });
});
