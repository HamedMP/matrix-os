import { describe, expect, it, vi } from "vitest";
import { MAX_APP_DATABASE_REQUEST_BYTES } from "@matrix-os/contracts";
import { CollaborationDirectError } from "@matrix-os/ui";

import { createOwnerCollaborativeAppTransport } from "../../shell/src/lib/owner-collaborative-app-transport.js";

const appId = "tracker";
const scopeId = "10000000-0000-4000-8000-000000000001";

function share(state: "active" | "needs_recheck" | "stopped") {
  return {
    scopeId,
    organizationId: "org_matrix_team",
    owner: { actorId: "user_owner", displayName: "Nima" },
    build: {
      appId,
      catalogId: "30000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64),
      manifestVersion: "1.0.0",
      buildId: "b".repeat(64),
      manifestDigest: "c".repeat(64),
      schemaDigest: "d".repeat(64),
      assetDigest: "e".repeat(64),
      bridgeContractVersion: "1",
      runtimeAbi: "1",
    },
    readinessId: "40000000-0000-4000-8000-000000000001",
    state,
    shareRevision: "1",
    bindingRevision: "1",
    dataRevision: "7",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  };
}

describe("owner collaborative app transport", () => {
  it("starts change notifications when an already-open owner app becomes shared", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn().mockReturnValue(vi.fn()) };
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(share("active"));
    const onChanged = vi.fn();
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get, direct }, legacyRequest: vi.fn().mockResolvedValue([]), onChanged,
    });
    await transport.query({ action: "find", table: "items" });
    expect(direct.subscribeEvents).not.toHaveBeenCalled();

    await transport.refreshShare();
    expect(direct.subscribeEvents).toHaveBeenCalledWith(scopeId, expect.objectContaining({ onEvent: onChanged }));
  });

  it("does not subscribe or send a request after closing during share lookup", async () => {
    let resolveShare!: (value: unknown) => void;
    const get = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveShare = resolve; }));
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const legacyRequest = vi.fn();
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get, direct }, legacyRequest, onChanged: vi.fn(),
    });
    const pending = transport.query({ action: "find", table: "items" });
    transport.close();
    resolveShare(share("active"));
    await expect(pending).rejects.toThrow("Collaboration unavailable");
    expect(direct.subscribeEvents).not.toHaveBeenCalled();
    expect(direct.request).not.toHaveBeenCalled();
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("does not send after closing between share discovery and the operation", async () => {
    const direct = {
      request: vi.fn().mockResolvedValue({ result: [], revision: "7" }),
      subscribeEvents: vi.fn().mockImplementation(() => {
        queueMicrotask(() => transport.close());
        return vi.fn();
      }),
    };
    const transport = createOwnerCollaborativeAppTransport({
      appId,
      api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(transport.query({ action: "find", table: "items" }))
      .rejects.toThrow("Collaboration unavailable");
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("keeps owner writes available after sharing stops and closes the old event stream", async () => {
    const unsubscribe = vi.fn();
    const direct = { request: vi.fn(), subscribeEvents: vi.fn().mockReturnValue(unsubscribe) };
    const legacyRequest = vi.fn().mockResolvedValue({ saved: true });
    const get = vi.fn().mockResolvedValueOnce(share("active")).mockResolvedValueOnce(share("stopped"));
    const transport = createOwnerCollaborativeAppTransport({ appId, api: { get, direct }, legacyRequest,
      onChanged: vi.fn() });

    await transport.refreshShare();
    await expect(transport.mutate({ action: "insert", table: "items", data: { id: "one" } }, "7"))
      .resolves.toEqual({ result: { saved: true }, revision: "0", replayed: false });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(direct.request).not.toHaveBeenCalled();
    expect(legacyRequest).toHaveBeenCalledWith({ action: "insert", table: "items", data: { id: "one" }, app: appId }, undefined);
  });

  it("rejects malformed, oversized, or cross-app owner requests before database access", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const get = vi.fn();
    const legacyRequest = vi.fn();
    const transport = createOwnerCollaborativeAppTransport({ appId, api: { get, direct }, legacyRequest,
      onChanged: vi.fn() });

    await expect(transport.query({ action: "listApps" })).rejects.toThrow("Collaboration unavailable");
    await expect(transport.query({ action: "" })).rejects.toThrow("Collaboration unavailable");
    await expect(transport.query({ action: "find", data: "x".repeat(MAX_APP_DATABASE_REQUEST_BYTES) }))
      .rejects.toThrow("Collaboration unavailable");
    const cyclic: Record<string, unknown> = { action: "find" };
    cyclic.self = cyclic;
    await expect(transport.query(cyclic)).rejects.toThrow("Collaboration unavailable");
    await expect(transport.mutate({ action: "update" }, "invalid revision"))
      .rejects.toThrow("Collaboration unavailable");
    expect(get).not.toHaveBeenCalled();
    expect(direct.request).not.toHaveBeenCalled();
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("rejects an aborted lookup without opening a stream or sending a write", async () => {
    const controller = new AbortController();
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const get = vi.fn().mockImplementation(async () => { controller.abort(); return share("active"); });
    const transport = createOwnerCollaborativeAppTransport({ appId, api: { get, direct },
      legacyRequest: vi.fn(), onChanged: vi.fn() });
    await expect(transport.mutate({ action: "update" }, "7", controller.signal))
      .rejects.toThrow("Collaboration unavailable");
    expect(get).toHaveBeenCalledWith(`/api/collaboration/apps/${appId}/share`, { signal: controller.signal });
    expect(direct.subscribeEvents).not.toHaveBeenCalled();
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("rejects a share for a different app instead of using its owner data", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const transport = createOwnerCollaborativeAppTransport({ appId, api: {
      get: vi.fn().mockResolvedValue({ ...share("active"), build: { ...share("active").build, appId: "other" } }), direct,
    }, legacyRequest: vi.fn(), onChanged: vi.fn() });
    await expect(transport.query({ action: "find" })).rejects.toThrow("Collaboration unavailable");
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("generates an idempotency key for owner writes and rejects later requests after close", async () => {
    const direct = {
      request: vi.fn().mockResolvedValue({ result: { saved: true }, revision: 8, replayed: false }),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()),
    };
    const get = vi.fn().mockResolvedValue(share("active"));
    const transport = createOwnerCollaborativeAppTransport({ appId, api: { get, direct },
      legacyRequest: vi.fn(), onChanged: vi.fn() });
    await expect(transport.mutate({ action: "update", table: "items", id: "one" }, "7"))
      .resolves.toEqual({ result: { saved: true }, revision: "8", replayed: false });
    expect(direct.request).toHaveBeenCalledWith(scopeId, "POST", expect.any(String),
      expect.objectContaining({ clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }), undefined, undefined);
    transport.close();
    await expect(transport.query({ action: "find" })).rejects.toThrow("Collaboration unavailable");
    expect(get).toHaveBeenCalledOnce();
  });

  it("retries an uncertain owner write with the identical request payload", async () => {
    const direct = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce({ result: { saved: true }, revision: 8, replayed: true }),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()),
    };
    const transport = createOwnerCollaborativeAppTransport({
      appId,
      api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(),
      onChanged: vi.fn(),
      createRequestId: () => "50000000-0000-4000-8000-000000000001",
    });

    await expect(transport.mutate({ action: "update", table: "items", id: "one" }, "7"))
      .rejects.toThrow("Collaboration unavailable");
    await expect(transport.retryMutation()).resolves.toEqual({
      result: { saved: true }, revision: "8", replayed: true,
    });

    expect(direct.request).toHaveBeenCalledTimes(2);
    expect(direct.request.mock.calls[1]).toEqual(direct.request.mock.calls[0]);
  });
  it("uses the active share's canonical direct query and mutation routes", async () => {
    const unsubscribe = vi.fn();
    const direct = {
      request: vi.fn()
        .mockResolvedValueOnce({ result: [{ id: "one" }], revision: "7" })
        .mockResolvedValueOnce({ result: { ok: true }, revision: 8, replayed: false }),
      subscribeEvents: vi.fn().mockReturnValue(unsubscribe),
    };
    const legacyRequest = vi.fn();
    const onChanged = vi.fn();
    const transport = createOwnerCollaborativeAppTransport({
      appId,
      api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest,
      onChanged,
      createRequestId: () => "50000000-0000-4000-8000-000000000001",
    });

    await expect(transport.query({ action: "find", table: "items" })).resolves.toEqual({
      result: [{ id: "one" }],
      revision: "7",
    });
    await expect(transport.mutate({ action: "update", table: "items", id: "one", data: { done: true } }, "7"))
      .resolves.toEqual({ result: { ok: true }, revision: "8", replayed: false });

    expect(legacyRequest).not.toHaveBeenCalled();
    expect(direct.request).toHaveBeenNthCalledWith(1, scopeId, "POST",
      `/api/collaboration/scopes/${scopeId}/apps/${appId}/view`,
      { action: { action: "find", table: "items", app: appId } }, undefined, undefined);
    expect(direct.request).toHaveBeenNthCalledWith(2, scopeId, "POST",
      `/api/collaboration/scopes/${scopeId}/apps/${appId}/actions`, {
        clientRequestId: "50000000-0000-4000-8000-000000000001",
        expectedRevision: "7",
        action: { action: "update", table: "items", id: "one", data: { done: true }, app: appId },
      }, undefined, undefined);
    expect(direct.subscribeEvents).toHaveBeenCalledWith(scopeId, expect.objectContaining({
      onEvent: onChanged,
    }));

    transport.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps unshared owner apps working through their existing database bridge", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const legacyRequest = vi.fn().mockResolvedValue([{ id: "one" }]);
    const transport = createOwnerCollaborativeAppTransport({
      appId,
      api: { get: vi.fn().mockResolvedValue(null), direct },
      legacyRequest,
      onChanged: vi.fn(),
    });

    await expect(transport.query({ action: "find", table: "items" })).resolves.toEqual({
      result: [{ id: "one" }],
      revision: "0",
    });
    expect(legacyRequest).toHaveBeenCalledWith({ action: "find", table: "items", app: appId }, undefined);
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("fails closed while a share needs rechecking", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn() };
    const legacyRequest = vi.fn();
    const transport = createOwnerCollaborativeAppTransport({
      appId,
      api: { get: vi.fn().mockResolvedValue(share("needs_recheck")), direct },
      legacyRequest,
      onChanged: vi.fn(),
    });

    await expect(transport.query({ action: "appInfo" })).rejects.toThrow("Collaboration unavailable");
    expect(legacyRequest).not.toHaveBeenCalled();
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("keeps a rejected owner write out of the retry queue after a known conflict", async () => {
    const direct = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockRejectedValueOnce(new CollaborationDirectError("invalid_request")),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()),
    };
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(), onChanged: vi.fn(),
      createRequestId: () => "50000000-0000-4000-8000-000000000001",
    });

    await expect(transport.mutate({ action: "update", table: "items" }, "7"))
      .rejects.toThrow("Collaboration unavailable");
    await expect(transport.retryMutation()).rejects.toThrow("Collaboration unavailable");
    await expect(transport.retryMutation()).rejects.toThrow("Collaboration unavailable");
    expect(direct.request).toHaveBeenCalledTimes(2);
    expect(direct.request.mock.calls[1]).toEqual(direct.request.mock.calls[0]);
  });

  it("bounds owner mutations whose outcome is unknown before issuing another write", async () => {
    const direct = {
      request: vi.fn().mockRejectedValue(new Error("response lost")),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()),
    };
    let nextId = 0;
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(), onChanged: vi.fn(),
      createRequestId: () => `request-${++nextId}`,
    });

    for (let index = 0; index < 32; index++) {
      await expect(transport.mutate({ action: "insert", table: "items", data: { index } }, "7"))
        .rejects.toThrow("Collaboration unavailable");
    }
    await expect(transport.mutate({ action: "insert", table: "items", data: { index: 32 } }, "7"))
      .rejects.toThrow("Collaboration unavailable");
    expect(direct.request).toHaveBeenCalledTimes(32);
  });

  it("does not send an owner mutation aborted while the share subscription opens", async () => {
    const controller = new AbortController();
    const direct = {
      request: vi.fn(),
      subscribeEvents: vi.fn().mockImplementation(() => {
        queueMicrotask(() => controller.abort());
        return vi.fn();
      }),
    };
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(), onChanged: vi.fn(),
    });

    await expect(transport.mutate({ action: "update", table: "items" }, "7", controller.signal))
      .rejects.toThrow("Collaboration unavailable");
    expect(direct.request).not.toHaveBeenCalled();
  });

  it("replays every uncertain owner mutation in order with its original request id", async () => {
    const direct = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error("first response lost"))
        .mockRejectedValueOnce(new Error("second response lost"))
        .mockResolvedValueOnce({ result: { saved: "first" }, revision: 8, replayed: true })
        .mockResolvedValueOnce({ result: { saved: "second" }, revision: 9, replayed: true }),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()),
    };
    let nextId = 0;
    const transport = createOwnerCollaborativeAppTransport({
      appId, api: { get: vi.fn().mockResolvedValue(share("active")), direct },
      legacyRequest: vi.fn(), onChanged: vi.fn(),
      createRequestId: () => `request-${++nextId}`,
    });

    await expect(transport.mutate({ action: "insert", data: { id: "first" } }, "7"))
      .rejects.toThrow("Collaboration unavailable");
    await expect(transport.mutate({ action: "insert", data: { id: "second" } }, "8"))
      .rejects.toThrow("Collaboration unavailable");
    await expect(transport.retryMutation()).resolves.toEqual({
      result: { saved: "second" }, revision: "9", replayed: true,
    });
    expect(direct.request.mock.calls[2]).toEqual(direct.request.mock.calls[0]);
    expect(direct.request.mock.calls[3]).toEqual(direct.request.mock.calls[1]);
  });
});
