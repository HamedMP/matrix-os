// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadinessSummary } from "../../packages/ui/src/collaboration/ReadinessSummary.js";
import { useCollaborativeAppSharing } from "../../packages/ui/src/collaboration/useCollaborativeAppSharing.js";

const build = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};
const blocked = {
  readinessId: "60000000-0000-4000-8000-000000000001",
  build,
  status: "blocked" as const,
  revision: "2",
  checks: [{
    code: "declaration" as const,
    status: "blocked" as const,
    action: "Declare collaborative capability.",
  }],
};
const ready = {
  ...blocked,
  status: "ready" as const,
  revision: "3",
  checks: [{ code: "cleanup" as const, status: "passed" as const }],
  verifiedAt: "2026-11-05T10:00:00.000Z",
};
const activeShare = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  owner: { actorId: "user_owner", displayName: "Nima" },
  build,
  readinessId: ready.readinessId,
  state: "active" as const,
  shareRevision: "1",
  bindingRevision: "1",
  dataRevision: "0",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("collaborative app owner readiness", () => {
  it("loads and validates the current exact-build certificate before allowing share", async () => {
    const api = { get: vi.fn(async () => blocked), post: vi.fn() };
    const { result } = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api }));
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    expect(result.current.readiness).toEqual(blocked);
    expect(result.current.canShare).toBe(false);
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/apps/team-tracker/readiness");
  });

  it("tracks a recheck, binds it to the exact incarnation, and enables share only after ready", async () => {
    let finish!: (value: unknown) => void;
    const api = {
      get: vi.fn(async () => blocked),
      post: vi.fn(async () => new Promise((resolve) => { finish = resolve; })),
    };
    const { result } = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api }));
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.recheck({
        organizationId: "org_matrix_team",
        clientRequestId: "70000000-0000-4000-8000-000000000001",
      });
    });
    expect(result.current.state).toBe("checking");
    expect(result.current.canShare).toBe(false);
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/team-tracker/readiness/check", {
      organizationId: "org_matrix_team",
      clientRequestId: "70000000-0000-4000-8000-000000000001",
      expectedRegistrationIncarnation: build.registrationIncarnation,
    });
    await act(async () => { finish(ready); await pending; });
    expect(result.current.state).toBe("ready");
    expect(result.current.canShare).toBe(true);
  });

  it("withdraws sharing immediately and reloads readiness when the same app build changes", async () => {
    let finishReload!: (value: unknown) => void;
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce(ready)
        .mockImplementationOnce(async () => new Promise((resolve) => { finishReload = resolve; })),
      post: vi.fn(),
    };
    const view = renderHook(({ buildEpoch }) => useCollaborativeAppSharing({
      appId: "team-tracker",
      api,
      buildEpoch,
    }), { initialProps: { buildEpoch: 1 } });
    await waitFor(() => expect(view.result.current.canShare).toBe(true));

    view.rerender({ buildEpoch: 2 });

    expect(view.result.current.canShare).toBe(false);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(view.result.current.state).toBe("loading");
    await act(async () => { finishReload(blocked); await Promise.resolve(); });
    await waitFor(() => expect(view.result.current.state).toBe("blocked"));
  });

  it("uses only bounded safe copy when the response or transport is invalid", async () => {
    const api = {
      get: vi.fn(async () => { throw new Error("postgres password=private"); }),
      post: vi.fn(async () => ({ ...blocked, checks: [{
        code: "cleanup",
        status: "failed",
        action: "/home/matrix/private database password",
      }] })),
    };
    const { result } = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api }));
    await waitFor(() => expect(result.current.state).toBe("failed"));
    expect(result.current.safeMessage).toBe("App collaboration readiness is unavailable.");
    expect(JSON.stringify(result.current)).not.toMatch(/postgres|password|\/home\/matrix/);
    await act(() => result.current.recheck({
      organizationId: "org_matrix_team",
      expectedRegistrationIncarnation: build.registrationIncarnation,
      clientRequestId: "70000000-0000-4000-8000-000000000002",
    }));
    expect(result.current.state).toBe("failed");
    expect(result.current.safeMessage).toBe("App collaboration readiness is unavailable.");

    const nonError = renderHook(() => useCollaborativeAppSharing({
      appId: "team-tracker",
      api: { get: async () => { throw "private-string"; }, post: async () => null },
    }));
    await waitFor(() => expect(nonError.result.current.state).toBe("failed"));
    nonError.unmount();
  });

  it("handles unchecked and invalid apps without issuing an unbound recheck", async () => {
    const api = { get: vi.fn(async () => null), post: vi.fn() };
    const view = renderHook(({ appId }) => useCollaborativeAppSharing({ appId, api }), {
      initialProps: { appId: "team-tracker" },
    });
    await waitFor(() => expect(view.result.current.state).toBe("idle"));
    await act(() => view.result.current.recheck({ organizationId: "org_matrix_team" }));
    expect(view.result.current.state).toBe("failed");
    expect(api.post).not.toHaveBeenCalled();

    view.rerender({ appId: "bad!" });
    await waitFor(() => expect(view.result.current.state).toBe("failed"));
    await act(() => view.result.current.recheck({
      organizationId: "org_matrix_team",
      expectedRegistrationIncarnation: build.registrationIncarnation,
    }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("drops stale load, failure, and recheck completions after the active app/request changes", async () => {
    const oldLoads: Array<{ resolve(value: unknown): void; reject(reason: unknown): void }> = [];
    let app = "first-app";
    const api = {
      get: vi.fn(async () => app === "first-app"
        ? new Promise((resolve, reject) => { oldLoads.push({ resolve, reject }); })
        : blocked),
      post: vi.fn(),
    };
    const view = renderHook(({ appId }) => useCollaborativeAppSharing({ appId, api }), {
      initialProps: { appId: "first-app" },
    });
    await waitFor(() => expect(oldLoads).toHaveLength(1));
    act(() => { void view.result.current.refresh(); });
    await waitFor(() => expect(oldLoads).toHaveLength(2));
    app = "team-tracker";
    view.rerender({ appId: "team-tracker" });
    await waitFor(() => expect(view.result.current.state).toBe("blocked"));
    await act(async () => { oldLoads[0]!.resolve(ready); await Promise.resolve(); });
    expect(view.result.current.state).toBe("blocked");
    await act(async () => { oldLoads[1]!.reject(new Error("old secret")); await Promise.resolve(); });
    expect(view.result.current.state).toBe("blocked");

    let finishRecheck!: (value: unknown) => void;
    api.post.mockImplementation(async () => new Promise((resolve) => { finishRecheck = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.recheck({ organizationId: "org_matrix_team" }); });
    await act(() => view.result.current.refresh());
    expect(view.result.current.state).toBe("blocked");
    await act(async () => { finishRecheck(ready); await pending; });
    expect(view.result.current.state).toBe("blocked");
  });

  it("creates a bounded request id when the caller does not provide one", async () => {
    const generated = "70000000-0000-4000-8000-000000000099";
    vi.stubGlobal("crypto", { randomUUID: () => generated });
    const api = { get: vi.fn(async () => blocked), post: vi.fn(async () => blocked) };
    const { result } = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api }));
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    await act(() => result.current.recheck({ organizationId: "org_matrix_team" }));
    expect(api.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ clientRequestId: generated }));
  });

  it("owns current-share, preflight, create, and CAS stop as one serializable controller", async () => {
    const stopped = { ...activeShare, state: "stopped" as const, shareRevision: "2", bindingRevision: "2" };
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? ready : null),
      post: vi.fn(async (path: string) => path.endsWith("/preflight") ? {
        eligible: true,
        catalogId: build.catalogId,
        resourceRevision: "0",
        readinessId: ready.readinessId,
        buildId: build.buildId,
        confirmationToken: "token_payload.signature_value",
      } : activeShare),
      delete: vi.fn(async () => stopped),
    };
    const { result } = renderHook(() => useCollaborativeAppSharing({
      appId: "team-tracker",
      api,
      manageShare: true,
    }));

    await waitFor(() => expect(result.current.shareKnown).toBe(true));
    expect(result.current.share).toBeNull();
    await act(() => result.current.createShare({ organizationId: "org_matrix_team" }));
    expect(result.current.share).toEqual(activeShare);
    expect(result.current.actionState).toBe("idle");
    expect(api.post).toHaveBeenLastCalledWith("/api/collaboration/apps/team-tracker/share", expect.objectContaining({
      organizationId: "org_matrix_team",
      expectedReadinessRevision: ready.revision,
      expectedResourceRevision: "0",
      buildId: build.buildId,
    }));

    await act(() => result.current.stopShare());
    expect(result.current.share).toEqual(stopped);
    expect(api.delete).toHaveBeenCalledWith("/api/collaboration/apps/team-tracker/share", expect.objectContaining({
      expectedShareRevision: "1",
      expectedBindingRevision: "1",
    }));
    expect(JSON.stringify(result.current)).not.toMatch(/token_payload|confirmationToken/);
  });

  it("loads an existing share and fails every unavailable share action with bounded copy", async () => {
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? ready : activeShare),
      post: vi.fn(async () => ({ eligible: false, reason: "readiness_stale" })),
    };
    const view = renderHook(() => useCollaborativeAppSharing({
      appId: "team-tracker", api, manageShare: true,
    }));
    await waitFor(() => expect(view.result.current.share).toEqual(activeShare));

    expect(await act(() => view.result.current.createShare({ organizationId: "org_matrix_team" }))).toBeNull();
    expect(view.result.current.actionState).toBe("failed");
    expect(view.result.current.actionMessage).toBe("App sharing is unavailable. Try again.");

    expect(await act(() => view.result.current.createShare({ organizationId: "bad organization" }))).toBeNull();
    expect(await act(() => view.result.current.stopShare())).toBeNull();
    expect(view.result.current.actionMessage).toBe("Sharing could not be stopped. Refresh and try again.");

    api.get.mockRejectedValueOnce("private share failure");
    await act(() => view.result.current.refreshShare());
    expect(view.result.current.share).toEqual(activeShare);
    expect(view.result.current.shareKnown).toBe(false);
    expect(view.result.current.actionMessage).toBe("App sharing is unavailable. Try again.");
    api.get.mockRejectedValueOnce(new Error("private share failure"));
    await act(() => view.result.current.refreshShare());
    expect(view.result.current.actionState).toBe("failed");
  });

  it("reuses an eligible preflight share and keeps share management idle when disabled", async () => {
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? ready : null),
      post: vi.fn(async () => ({
        eligible: true,
        catalogId: build.catalogId,
        resourceRevision: "0",
        readinessId: ready.readinessId,
        buildId: build.buildId,
        confirmationToken: "token_payload.signature_value",
        existingShare: activeShare,
      })),
    };
    const managed = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api, manageShare: true }));
    await waitFor(() => expect(managed.result.current.shareKnown).toBe(true));
    await act(() => managed.result.current.createShare({
      organizationId: "org_matrix_team",
      clientRequestId: "80000000-0000-4000-8000-000000000001",
    }));
    expect(managed.result.current.share).toEqual(activeShare);
    expect(api.post).toHaveBeenCalledTimes(1);

    const unmanaged = renderHook(() => useCollaborativeAppSharing({ appId: "bad!", api }));
    await act(() => unmanaged.result.current.refreshShare());
    expect(unmanaged.result.current).toMatchObject({ share: null, shareKnown: true, actionState: "idle" });
  });

  it("drops stale create and stop completions after a newer share refresh", async () => {
    let finishCreate!: (value: unknown) => void;
    let finishStop!: (value: unknown) => void;
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? ready : activeShare),
      post: vi.fn(async () => new Promise((resolve) => { finishCreate = resolve; })),
      delete: vi.fn(async () => new Promise((resolve) => { finishStop = resolve; })),
    };
    const view = renderHook(() => useCollaborativeAppSharing({
      appId: "team-tracker", api, manageShare: true,
    }));
    await waitFor(() => expect(view.result.current.share).toEqual(activeShare));

    let create!: Promise<unknown>;
    act(() => { create = view.result.current.createShare({ organizationId: "org_matrix_team" }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    await act(() => view.result.current.refreshShare());
    await act(async () => {
      finishCreate({
        eligible: true, catalogId: build.catalogId, resourceRevision: "0",
        readinessId: ready.readinessId, buildId: build.buildId,
        confirmationToken: "token_payload.signature_value", existingShare: activeShare,
      });
      expect(await create).toBeNull();
    });

    let stop!: Promise<unknown>;
    act(() => { stop = view.result.current.stopShare(); });
    await waitFor(() => expect(api.delete).toHaveBeenCalledOnce());
    await act(() => view.result.current.refreshShare());
    await act(async () => {
      finishStop({ ...activeShare, state: "stopped", shareRevision: "2", bindingRevision: "2" });
      expect(await stop).toBeNull();
    });

    api.post.mockRejectedValueOnce("private create failure");
    await act(() => view.result.current.createShare({ organizationId: "org_matrix_team" }));
    api.delete.mockRejectedValueOnce("private stop failure");
    await act(() => view.result.current.stopShare());
    expect(view.result.current.actionState).toBe("failed");
  });

  it("drops superseded share refresh and rejected action completions", async () => {
    const shareRequests: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
    let rejectCreate!: (error: unknown) => void;
    let rejectStop!: (error: unknown) => void;
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? ready
        : new Promise((resolve, reject) => shareRequests.push({ resolve, reject }))),
      post: vi.fn(async () => new Promise((_resolve, reject) => { rejectCreate = reject; })),
      delete: vi.fn(async () => new Promise((_resolve, reject) => { rejectStop = reject; })),
    };
    const view = renderHook(() => useCollaborativeAppSharing({ appId: "team-tracker", api, manageShare: true }));
    await waitFor(() => expect(shareRequests).toHaveLength(1));
    act(() => { void view.result.current.refreshShare(); });
    await waitFor(() => expect(shareRequests).toHaveLength(2));
    await act(async () => { shareRequests[1]!.resolve(activeShare); await Promise.resolve(); });
    await act(async () => { shareRequests[0]!.resolve(null); await Promise.resolve(); });
    expect(view.result.current.share).toEqual(activeShare);

    act(() => { void view.result.current.refreshShare(); });
    await waitFor(() => expect(shareRequests).toHaveLength(3));
    act(() => { void view.result.current.refreshShare(); });
    await waitFor(() => expect(shareRequests).toHaveLength(4));
    await act(async () => { shareRequests[2]!.reject("old refresh failure"); await Promise.resolve(); });
    await act(async () => { shareRequests[3]!.resolve(activeShare); await Promise.resolve(); });

    act(() => { void view.result.current.createShare({ organizationId: "org_matrix_team" }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    act(() => { void view.result.current.refreshShare(); });
    await waitFor(() => expect(shareRequests).toHaveLength(5));
    await act(async () => { rejectCreate("stale create failure"); await Promise.resolve(); });
    await act(async () => { shareRequests[4]!.resolve(activeShare); await Promise.resolve(); });

    act(() => { void view.result.current.stopShare(); });
    await waitFor(() => expect(api.delete).toHaveBeenCalledOnce());
    act(() => { void view.result.current.refreshShare(); });
    await waitFor(() => expect(shareRequests).toHaveLength(6));
    await act(async () => { rejectStop("stale stop failure"); await Promise.resolve(); });
    await act(async () => { shareRequests[5]!.resolve(activeShare); await Promise.resolve(); });

    const blockedApi = { get: vi.fn(async () => blocked), post: vi.fn() };
    const blockedView = renderHook(() => useCollaborativeAppSharing({
      appId: "team-tracker", api: blockedApi,
    }));
    await waitFor(() => expect(blockedView.result.current.state).toBe("blocked"));
    await act(() => blockedView.result.current.createShare({ organizationId: "org_matrix_team" }));
    const invalidView = renderHook(() => useCollaborativeAppSharing({ appId: "bad!", api }));
    await act(() => invalidView.result.current.createShare({ organizationId: "org_matrix_team" }));
    expect(invalidView.result.current.actionState).toBe("failed");
  });

  it("renders actionable safe summaries for every readiness outcome", () => {
    const outcomes = [
      { value: { ...blocked, status: "checking" as const, checks: [] }, text: "Checking the exact app build" },
      { value: blocked, text: "Declare collaborative capability." },
      { value: ready, text: "This exact app build is ready to share." },
      { value: { ...blocked, status: "stale" as const, invalidatedAt: "2026-11-05T11:00:00.000Z" }, text: "The app changed. Run readiness again." },
      { value: { ...blocked, status: "failed" as const, checks: [{ code: "cleanup" as const, status: "failed" as const, action: "Readiness could not be verified. Try again." }] }, text: "Readiness could not be verified. Try again." },
    ];
    for (const outcome of outcomes) {
      const view = render(<ReadinessSummary readiness={outcome.value} />);
      expect(screen.getByLabelText("App collaboration readiness").textContent).toContain(outcome.text);
      view.unmount();
    }
  });
});
