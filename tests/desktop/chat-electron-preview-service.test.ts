import { describe, expect, it, vi } from "vitest";
import type { MacActionPairing } from "@desktop/main/desktop-pairing/action";
import { createChatElectronPreviewService } from "@desktop/main/chat-electron-preview/service";
import { ChatElectronPreviewTransportInterruptedError } from "@desktop/main/chat-electron-preview/transport";

const identity = { chatId: "chat_test", runId: "run_test" };
const request = {
  ...identity, projectId: "proj_test", worktreeId: "wt_test", label: "YOUR SPACE TO BUILD",
  baseSha: "a".repeat(40), sourceSha256: "b".repeat(64), scopeKey: "c".repeat(64),
  expiresAt: Date.now() + 60_000,
};
const preview = { png: Buffer.from("test picture"), testSummary: "10 passed" };

function setup(acquireActionPairing?: MacActionPairing) {
  const seen = new Set<string>();
  const activity = { update: vi.fn(), finish: vi.fn() };
  const deps = {
    enabled: true,
    acquireActionPairing,
    read: vi.fn().mockResolvedValue(request),
    isCurrent: vi.fn(() => true),
    wasHandled: vi.fn(async (key: string) => seen.has(key)),
    claim: vi.fn(async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    approve: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue(preview),
    returnResult: vi.fn().mockResolvedValue(undefined),
    beginActivity: vi.fn(() => activity),
  };
  return { deps, activity, service: createChatElectronPreviewService(deps) };
}

describe("one-time Electron Desktop preview", () => {
  it("requires the paired key after consent before claiming or running the preview", async () => {
    const acquireActionPairing = vi.fn(async () => null);
    const { deps, activity, service } = setup(acquireActionPairing);
    expect(await service.run(identity)).toEqual({ status: "unavailable" });
    expect(deps.approve).toHaveBeenCalledOnce();
    expect(acquireActionPairing).toHaveBeenCalledOnce();
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("does not execute a typed verification read which changed request kind during consent", async () => {
    const { deps, service } = setup(async () => ({
      check: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    }));
    const verified = { ...request, requestKind: "verification" as const };
    deps.read.mockResolvedValueOnce(verified).mockResolvedValueOnce(request);
    expect(await service.run({ ...identity, requestKind: "verification" })).toEqual({ status: "unavailable" });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.returnResult).not.toHaveBeenCalled();
  });

  it("requires native pairing even if the typed verification has a locally approved operation", async () => {
    const { deps, service } = setup();
    const verified = { ...request, requestKind: "verification" as const };
    deps.read.mockResolvedValue(verified);
    expect(await service.run({ ...identity, requestKind: "verification" })).toEqual({ status: "unavailable" });
    expect(deps.approve).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("drops the preview result after a device revision changes during the build", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const close = vi.fn();
    const { deps, activity, service } = setup(async operation => {
      check.mockImplementationOnce(async () => true)
        .mockImplementationOnce(async () => { operation.abort("revoked"); return false; });
      return { check, close };
    });
    expect(await service.run(identity)).toEqual({ status: "unavailable" });
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.returnResult).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
    expect(close).toHaveBeenCalledOnce();
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
  });

  it("does not retry a dropped receipt after revocation of the Full Access grant that skipped consent", async () => {
    const actionCheck = vi.fn(async () => true);
    const originalGrantCheck = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { deps, service } = setup(async () => ({ check: actionCheck, close: vi.fn() }));
    const verified = { ...request, requestKind: "verification" as const };
    deps.read.mockResolvedValue(verified);
    deps.approve.mockResolvedValue({ check: originalGrantCheck });
    deps.returnResult.mockRejectedValueOnce(new ChatElectronPreviewTransportInterruptedError(new TypeError("Disconnected")));
    expect(await service.run({ ...identity, requestKind: "verification" })).toEqual({ status: "unavailable" });
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.returnResult).toHaveBeenCalledOnce();
  });

  it("uses one explicit approval, builds the bound version and returns evidence once", async () => {
    const { deps, activity, service } = setup();
    expect(await service.run(identity)).toEqual({ status: "returned" });
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(deps.returnResult).toHaveBeenCalledWith(request, preview, expect.any(AbortSignal));
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.returnResult).toHaveBeenCalledTimes(1);
    expect(deps.beginActivity).toHaveBeenCalledExactlyOnceWith("preview", request.worktreeId);
    expect(activity.update.mock.calls.flat()).toEqual(["awaiting-approval", "running", "returning"]);
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("returned");
  });

  it("remembers a decline and never executes or posts a result", async () => {
    const { deps, service } = setup();
    deps.approve.mockResolvedValue(false);
    expect(await service.run(identity)).toEqual({ status: "declined" });
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.returnResult).not.toHaveBeenCalled();
  });

  it("fails closed when the profile changes during consent", async () => {
    const { deps, activity, service } = setup();
    deps.approve.mockImplementation(async () => { deps.isCurrent.mockReturnValue(false); return true; });
    expect(await service.run(identity)).toEqual({ status: "unavailable" });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
    expect(activity.update).toHaveBeenCalledExactlyOnceWith("awaiting-approval");
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it.each([
    null, { ...request, sourceSha256: "d".repeat(64) }, { ...request, worktreeId: "wt_other" },
    { ...request, operation: "verify-sign-in-recovery" },
  ])(
    "refuses to build a source or worktree which changed while consent was open",
    async refreshed => {
      const { deps, service } = setup();
      deps.read.mockResolvedValueOnce(request).mockResolvedValueOnce(refreshed);
      expect(await service.run(identity)).toEqual({ status: "unavailable" });
      expect(deps.approve).toHaveBeenCalledTimes(1);
      expect(deps.read).toHaveBeenNthCalledWith(2, identity, undefined, expect.any(AbortSignal));
      expect(deps.execute).not.toHaveBeenCalled();
      expect(deps.returnResult).not.toHaveBeenCalled();
      expect(await service.run(identity)).toEqual({ status: "already-handled" });
    },
  );

  it("bounds concurrent previews and aborts the active build on account changes", async () => {
    const { deps, service } = setup();
    let started = () => {};
    const building = new Promise<void>(resolve => { started = resolve; });
    deps.execute.mockImplementation((_request, signal: AbortSignal) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const result = service.run(identity);
    await building;
    expect(await service.run(identity)).toEqual({ status: "busy" });
    service.cancel();
    expect(await result).toEqual({ status: "unavailable" });
    expect(deps.returnResult).not.toHaveBeenCalled();
  });

  it("returns a bounded failure to the same Chat and never reruns the build", async () => {
    const { deps, service } = setup();
    deps.execute.mockRejectedValue(new Error("test/build failed"));
    expect(await service.run(identity)).toEqual({ status: "failed" });
    expect(deps.returnResult).toHaveBeenCalledWith(request, { error: "build-failed" }, expect.any(AbortSignal));
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
  });

  it("lets the native Stop cancel a foreground result upload and retires the visible activity", async () => {
    const { deps, activity, service } = setup();
    let signalAtDelivery!: AbortSignal;
    let start = () => {};
    const returning = new Promise<void>(resolve => { start = resolve; });
    deps.returnResult.mockImplementation((_request, _result, signal?: AbortSignal) => {
      signalAtDelivery = signal!;
      start();
      if (!signal) throw new Error("expected a cancelable foreground delivery");
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const outcome = service.run(identity);
    await returning;
    await service.cancel("stopped");

    expect(await outcome).toEqual({ status: "unavailable" });
    expect(signalAtDelivery.aborted).toBe(true);
    expect(activity.update.mock.calls.flat()).toEqual(["awaiting-approval", "running", "returning"]);
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
  });

  it("keeps the verified result outcome when Stop is concurrent with its successful receipt", async () => {
    const { deps, activity, service } = setup();
    deps.returnResult.mockImplementation(async () => {
      void service.cancel("stopped");
    });
    expect(await service.run(identity)).toEqual({ status: "returned" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("returned");
  });

  it("requires the original background pairing before a newly approved preview executes", async () => {
    const { deps, service } = setup(async () => ({
      check: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    }));
    const background = new AbortController();
    const check = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      background.abort("revoked");
      return false;
    });
    const result = await service.run(identity, {
      signal: background.signal,
      grant: { targetId: "d5739cf6-cb60-4b79-99a1-d95c23949a5c", approvedAt: Date.now() },
      context: request,
      pairing: { check, close: vi.fn() },
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(deps.approve).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledTimes(2);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.returnResult).not.toHaveBeenCalled();
  });

  it("cancels a background preview and skips return if its grant stops", async () => {
    const { deps, service } = setup();
    const grant = new AbortController();
    let canStop = () => {};
    const started = new Promise<void>(resolve => { canStop = resolve; });
    deps.execute.mockImplementation(async (_request, signal: AbortSignal) => {
      canStop();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return preview;
    });
    const outcome = service.run(identity, {
      signal: grant.signal,
      grant: { targetId: "d5739cf6-cb60-4b79-99a1-d95c23949a5c", approvedAt: Date.now() },
      context: request,
    });
    await started;
    grant.abort();

    expect(await outcome).toEqual({ status: "unavailable" });
    expect(deps.approve).toHaveBeenCalledOnce();
    expect(deps.returnResult).not.toHaveBeenCalled();
  });
});
