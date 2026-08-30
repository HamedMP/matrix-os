import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { AppError } from "../../desktop/src/shared/app-error";
import {
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
      desktop: {
        icons: [
          { path: "__terminal__", x: 40, y: 50 },
          { path: "__chat__", x: 20, y: 30 },
        ],
      },
    });
    expect(api.patch.mock.calls[2][1].baseRevision).toBe(9);
  });
});
