import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import {
  patchWebOsViewState,
  resetWebOsViewStateClientForTests,
} from "../../shell/src/lib/os-view-state-client";

const latest = {
  revision: 4,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("Web OS-view state client", () => {
  beforeEach(() => resetWebOsViewStateClientForTests());

  it("reloads and retries the same mutation after a revision conflict", async () => {
    const afterRetry = { ...latest, revision: 8 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => latest })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => afterRetry })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...afterRetry, revision: 9 }) });
    vi.stubGlobal("fetch", fetchMock);

    await patchWebOsViewState("http://gateway.test", { pinnedApps: ["__chat__"] });
    await patchWebOsViewState("http://gateway.test", { desktop: { icons: [] } });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retried = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(first.baseRevision).toBe(1);
    expect(retried.baseRevision).toBe(4);
    expect(retried.mutationId).toBe(first.mutationId);
    expect(retried.patch).toEqual({ pinnedApps: ["__chat__"] });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).baseRevision).toBe(8);
  });
});
