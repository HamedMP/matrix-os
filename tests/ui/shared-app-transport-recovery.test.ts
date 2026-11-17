import { describe, expect, it, vi } from "vitest";
import { createSharedAppTransport, SharedAppTransportError, type SharedAppTarget } from "../../packages/ui/src/collaboration/shared-app-transport.js";
import { CollaborationDirectError } from "../../packages/ui/src/collaboration/direct-client.js";

const target: SharedAppTarget = {
  scopeId: "10000000-0000-4000-8000-000000000001", organizationId: "org_matrix_team", appId: "team-tracker",
  catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "2", authorityGeneration: 3,
  runtimeId: "vps:50000000-0000-4000-8000-000000000001", owner: { actorId: "user_owner", displayName: "Owner" },
};
function setup() {
  return {
    platform: { get: vi.fn(), post: vi.fn() },
    direct: {
      request: vi.fn(async (_scope: string, _method: string, _path: string, _body?: unknown) =>
        ({ result: { saved: true }, revision: 3, replayed: false })),
      subscribeEvents: vi.fn().mockReturnValue(vi.fn()), close: vi.fn(),
    },
  };
}

describe("shared app save and lifecycle recovery", () => {
  it("keeps readiness errors actionable and hides raw read failures", async () => {
    const { platform, direct } = setup();
    direct.request
      .mockRejectedValueOnce(new SharedAppTransportError("needs_recheck", false))
      .mockRejectedValueOnce("postgres://private-host/password=secret");
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    await expect(transport.query({ action: "find", table: "tasks" })).rejects.toMatchObject({
      code: "needs_recheck", message: "This shared app needs to be checked again by its owner.",
    });
    await expect(transport.query({ action: "find", table: "tasks" })).rejects.toMatchObject({
      code: "unavailable", message: "Shared app is unavailable.",
    });
  });
  it.each([false, true])("prioritizes ended access over conflicts (denial first: %s)", async (denialFirst) => {
    const { platform, direct } = setup();
    const failures = denialFirst ? ["denied", "invalid_request"] as const : ["invalid_request", "denied"] as const;
    direct.request
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError(failures[0]))
      .mockRejectedValueOnce(new CollaborationDirectError(failures[1]));
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    for (const title of ["First", "Second"]) {
      await expect(transport.mutate({ action: "insert", table: "tasks", data: { title } }, "2"))
        .rejects.toMatchObject({ code: "uncertain" });
    }
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "access_ended" });
  });

  it("shares one recovery outcome across overlapping Retry clicks", async () => {
    const { platform, direct } = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    direct.request
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("denied"))
      .mockImplementationOnce(async () => {
        await blocked;
        return { result: { saved: true }, revision: 4, replayed: true };
      });
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    for (const title of ["First", "Second"]) {
      await expect(transport.mutate({ action: "insert", table: "tasks", data: { title } }, "2"))
        .rejects.toMatchObject({ code: "uncertain" });
    }
    const first = transport.retryMutation();
    await vi.waitFor(() => expect(direct.request).toHaveBeenCalledTimes(4));
    const second = transport.retryMutation();
    release();
    const outcomes = await Promise.allSettled([first, second]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "access_ended" });
    }
    expect(direct.request).toHaveBeenCalledTimes(4);
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "conflict" });
  });

  it("stops queued replays when closed during recovery", async () => {
    const { platform, direct } = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    direct.request
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockImplementationOnce(async () => {
        await blocked;
        return { result: { saved: true }, revision: 4, replayed: true };
      });
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    for (const title of ["First", "Second"]) {
      await expect(transport.mutate({ action: "insert", table: "tasks", data: { title } }, "2"))
        .rejects.toMatchObject({ code: "uncertain" });
    }
    const recovering = transport.retryMutation();
    const outcome = expect(recovering).rejects.toMatchObject({ code: "uncertain" });
    await vi.waitFor(() => expect(direct.request).toHaveBeenCalledTimes(3));
    transport.close();
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "unavailable" });
    release();
    await outcome;
    expect(direct.request).toHaveBeenCalledTimes(3);
  });

  it("replays a committed mutation with a malformed acknowledgement using its original request id", async () => {
    const { platform, direct } = setup();
    const committed = new Set<string>();
    direct.request.mockImplementation(async (_scope, _method, _path, body) => {
      const { clientRequestId } = body as { clientRequestId: string };
      if (!committed.has(clientRequestId)) {
        committed.add(clientRequestId);
        // The production direct client throws this when a successful reply is
        // non-JSON, oversized, or malformed. The write may already be committed.
        throw new CollaborationDirectError("invalid_response");
      }
      return { result: { saved: true }, revision: 3, replayed: true };
    });
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    await expect(transport.mutate({ action: "insert", table: "tasks", data: { title: "Kept" } }, "2"))
      .rejects.toMatchObject({ code: "uncertain", retryable: true });
    await expect(transport.retryMutation()).resolves.toMatchObject({ revision: "3", replayed: true });
    expect(committed.size).toBe(1);
    expect(direct.request.mock.calls[1]![3]).toEqual(direct.request.mock.calls[0]![3]);
  });

  it("does not reopen a closed viewer's session or send a retained mutation", async () => {
    const { platform, direct } = setup();
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
    await expect(transport.mutate({ action: "insert", table: "tasks", data: { title: "Pending" } }, "2"))
      .rejects.toMatchObject({ code: "uncertain" });
    transport.close();
    transport.close();
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "unavailable" });
    await expect(transport.mutate({ action: "delete", table: "tasks", id: "one" }, "2"))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(transport.query({ action: "find", table: "tasks" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(transport.launch()).rejects.toMatchObject({ code: "unavailable" });
    expect(() => transport.subscribe({ onChanged: vi.fn(), onUnavailable: vi.fn() }))
      .toThrow("Shared app is unavailable.");
    expect(platform.post).not.toHaveBeenCalled();
    expect(direct.request).toHaveBeenCalledTimes(1);
    expect(direct.subscribeEvents).not.toHaveBeenCalled();
    expect(direct.close).toHaveBeenCalledOnce();
  });

  it("remembers denied writes while another queued save still needs recovery", async () => {
    const { platform, direct } = setup();
    direct.request
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockRejectedValueOnce(new CollaborationDirectError("denied"))
      .mockRejectedValueOnce(new CollaborationDirectError("unavailable"))
      .mockResolvedValueOnce({ result: { saved: true }, revision: 4, replayed: true });
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    for (const title of ["First", "Second"]) {
      await expect(transport.mutate({ action: "insert", table: "tasks", data: { title } }, "2"))
        .rejects.toMatchObject({ code: "uncertain" });
    }
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "uncertain" });
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "access_ended" });
    expect(direct.request).toHaveBeenCalledTimes(5);
    await expect(transport.retryMutation()).rejects.toMatchObject({ code: "conflict" });
  });

});
