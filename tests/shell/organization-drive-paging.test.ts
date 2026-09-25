import { describe, expect, it, vi } from "vitest";
import {
  createRefreshGuard,
  loadDiscoveryItems,
  loadDriveSnapshotPages,
} from "../../shell/src/components/file-browser/organization-drive-paging";

const SCOPE_ID = "00000000-0000-4000-8000-0000000000aa";

function discoveryItem(index: number) {
  return {
    scopeId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    runtimeId: "runtime_ash",
    ownerId: "user_ash",
    kind: "folder",
    authorityGeneration: 1,
    organizationId: "org_authority",
    status: "accepted",
  };
}

function file(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organizationId: "org_authority",
    path: `reports/file-${index}.txt`,
    version: 1,
    size: 5,
    sha256: "a".repeat(64),
    updatedBy: "user_ash",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

function snapshot(fileIndex: number, nextCursor?: string) {
  return {
    organizationId: "org_authority",
    scopeId: SCOPE_ID,
    usedBytes: 5,
    reservedBytes: 0,
    quotaBytes: 1_000_000_000_000,
    files: [file(fileIndex)],
    ...(nextCursor ? { nextCursor } : {}),
  };
}

describe("organization drive discovery paging", () => {
  it("returns drives already found when the page limit is reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let page = 0;
    const get = vi.fn(async () => {
      page += 1;
      return { items: [discoveryItem(page)], nextCursor: `cursor-${page}` };
    });

    const items = await loadDiscoveryItems(get, "shared", 3);

    expect(get).toHaveBeenCalledTimes(3);
    expect(items.map((item) => item.scopeId)).toEqual([
      discoveryItem(1).scopeId, discoveryItem(2).scopeId, discoveryItem(3).scopeId,
    ]);
    expect(warn).toHaveBeenCalledWith("[organization-drive] discovery page limit reached", "shared");
    warn.mockRestore();
  });

  it("follows cursors until the last page", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ items: [discoveryItem(1)], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [discoveryItem(2)] });

    const items = await loadDiscoveryItems(get, "inbox");

    expect(items).toHaveLength(2);
    expect(get).toHaveBeenLastCalledWith("/api/collaboration/inbox?limit=100&cursor=next");
  });
});

describe("organization drive snapshot paging", () => {
  it("reloads previously loaded pages so a refresh keeps later files", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(snapshot(1, "reports/file-1.txt"))
      .mockResolvedValueOnce(snapshot(2, "reports/file-2.txt"))
      .mockResolvedValueOnce(snapshot(3, "reports/file-3.txt"));

    const result = await loadDriveSnapshotPages(request, SCOPE_ID, 3);

    expect(result.pages).toBe(3);
    expect(result.snapshot.files.map((entry) => entry.path)).toEqual([
      "reports/file-1.txt", "reports/file-2.txt", "reports/file-3.txt",
    ]);
    expect(result.snapshot.nextCursor).toBe("reports/file-3.txt");
    expect(request).toHaveBeenNthCalledWith(2,
      `/api/collaboration/scopes/${SCOPE_ID}/drive?after=${encodeURIComponent("reports/file-1.txt")}`);
  });

  it("stops early when the drive has fewer pages than before", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(snapshot(1, "reports/file-1.txt"))
      .mockResolvedValueOnce(snapshot(2));

    const result = await loadDriveSnapshotPages(request, SCOPE_ID, 5);

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    expect(result.snapshot.nextCursor).toBeUndefined();
  });

  it("caps the number of pages reloaded on refresh", async () => {
    let page = 0;
    const request = vi.fn(async () => {
      page += 1;
      return snapshot(page, `reports/file-${page}.txt`);
    });

    const result = await loadDriveSnapshotPages(request, SCOPE_ID, 10_000);

    expect(result.pages).toBe(20);
    expect(request).toHaveBeenCalledTimes(20);
  });
});

describe("organization drive refresh guard", () => {
  it("drops a refresh that started before a newer page load finished", () => {
    const guard = createRefreshGuard();
    const refresh = guard.begin();
    guard.invalidate();

    expect(guard.isCurrent(refresh)).toBe(false);
    expect(guard.isCurrent(guard.begin())).toBe(true);
  });

  it("keeps only the latest of overlapping refreshes", () => {
    const guard = createRefreshGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("reports whether a refresh is still in flight", () => {
    const guard = createRefreshGuard();
    expect(guard.inFlight()).toBe(false);
    const refresh = guard.begin();
    expect(guard.inFlight()).toBe(true);
    guard.finish(refresh);
    expect(guard.inFlight()).toBe(false);
  });
});
