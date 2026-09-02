import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { AppError } from "../../desktop/src/shared/app-error";
import {
  importNativeLegacyDesktopConfig,
  patchNativeOsViewState,
  resetNativeOsViewStateClientForTests,
} from "@desktop/renderer/src/lib/os-view-state-client";

const latest = {
  revision: 6,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("Electron Desktop OS-view state client", () => {
  beforeEach(() => resetNativeOsViewStateClientForTests());

  it("imports only present legacy Desktop fields and primes the durable cache", async () => {
    const imported = { ...latest, revision: 2 };
    const api = {
      post: vi.fn(async () => imported),
    };

    await expect(importNativeLegacyDesktopConfig(api as never, {
      pinnedApps: ["__chat__"],
    })).resolves.toEqual(imported);

    expect(api.post).toHaveBeenCalledWith(
      "/api/os-view-state/import-legacy-desktop",
      { pinnedApps: ["__chat__"] },
    );
  });

  it("reloads and retries the same mutation after a revision conflict", async () => {
    const latestAfterConflict = {
      ...latest,
      document: {
        ...latest.document,
        desktop: {
          ...latest.document.desktop,
          icons: [{ path: "__terminal__", x: 40, y: 50 }],
        },
      },
    };
    const afterRetry = { ...latestAfterConflict, revision: 9 };
    const api = {
      get: vi.fn(async () => latestAfterConflict),
      patch: vi.fn()
        .mockRejectedValueOnce(new AppError("server", { detail: "os_view_state_conflict" }))
        .mockResolvedValueOnce(afterRetry)
        .mockResolvedValueOnce({ ...afterRetry, revision: 10 }),
    };

    await patchNativeOsViewState(api as never, {
      desktop: { icons: [{ path: "__chat__", x: 20, y: 30 }] },
    });
    await patchNativeOsViewState(api as never, { pinnedApps: ["__chat__"] });

    const first = api.patch.mock.calls[0][1];
    const retried = api.patch.mock.calls[1][1];
    expect(first.baseRevision).toBe(1);
    expect(retried.baseRevision).toBe(6);
    expect(retried.mutationId).toBe(first.mutationId);
    expect(retried.patch).toEqual({
      desktop: { icons: [{ path: "__chat__", x: 20, y: 30 }] },
    });
    expect(api.patch.mock.calls[2][1].baseRevision).toBe(9);
  });

  it("keeps rebasing the pending mutation when the retry also conflicts", async () => {
    const firstLatest = {
      ...latest,
      document: {
        ...latest.document,
        pinnedApps: ["__terminal__"],
      },
    };
    const secondLatest = {
      ...firstLatest,
      revision: 8,
      document: {
        ...firstLatest.document,
        pinnedApps: ["__terminal__", "__file-browser__"],
      },
    };
    const afterRetry = { ...secondLatest, revision: 9 };
    const conflict = new AppError("server", { detail: "os_view_state_conflict" });
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce(firstLatest)
        .mockResolvedValueOnce(secondLatest),
      patch: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce(afterRetry),
    };

    await patchNativeOsViewState(api as never, { pinnedApps: ["__chat__"] });

    const first = api.patch.mock.calls[0][1];
    const firstRetry = api.patch.mock.calls[1][1];
    const secondRetry = api.patch.mock.calls[2][1];
    expect(firstRetry.baseRevision).toBe(6);
    expect(secondRetry.baseRevision).toBe(8);
    expect(firstRetry.mutationId).toBe(first.mutationId);
    expect(secondRetry.mutationId).toBe(first.mutationId);
    expect(secondRetry.patch).toEqual({
      pinnedApps: ["__terminal__", "__file-browser__", "__chat__"],
    });
  });

  it("bounds conflict retries so a contended mutation cannot block the queue", async () => {
    const conflict = new AppError("server", { detail: "os_view_state_conflict" });
    const revisions = [6, 7, 8].map((revision) => ({ ...latest, revision }));
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce(revisions[0])
        .mockResolvedValueOnce(revisions[1])
        .mockResolvedValueOnce(revisions[2]),
      patch: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({ ...latest, revision: 9 }),
    };

    await expect(patchNativeOsViewState(api as never, { pinnedApps: ["__chat__"] }))
      .rejects.toThrow("conflicted repeatedly");
    await patchNativeOsViewState(api as never, { desktop: { icons: [] } });

    expect(api.patch.mock.calls[4][1].baseRevision).toBe(8);
  });
});
