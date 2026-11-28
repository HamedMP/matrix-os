import { describe, expect, it, vi } from "vitest";
import { createChatElectronPreviewService } from "@desktop/main/chat-electron-preview/service";

const identity = { chatId: "chat_test", runId: "run_test" };
const request = {
  ...identity, projectId: "proj_test", worktreeId: "wt_test", label: "YOUR SPACE TO BUILD",
  baseSha: "a".repeat(40), sourceSha256: "b".repeat(64), scopeKey: "c".repeat(64),
  expiresAt: Date.now() + 60_000,
};
const preview = { png: Buffer.from("test picture"), testSummary: "10 passed" };

function setup() {
  const seen = new Set<string>();
  const deps = {
    enabled: true,
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
  };
  return { deps, service: createChatElectronPreviewService(deps) };
}

describe("one-time Electron Desktop preview", () => {
  it("uses one explicit approval, builds the bound version and returns evidence once", async () => {
    const { deps, service } = setup();
    expect(await service.run(identity)).toEqual({ status: "returned" });
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(deps.returnResult).toHaveBeenCalledWith(request, preview, expect.any(AbortSignal));
    expect(await service.run(identity)).toEqual({ status: "already-handled" });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.returnResult).toHaveBeenCalledTimes(1);
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
    const { deps, service } = setup();
    deps.approve.mockImplementation(async () => { deps.isCurrent.mockReturnValue(false); return true; });
    expect(await service.run(identity)).toEqual({ status: "unavailable" });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
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
      expect(deps.read).toHaveBeenNthCalledWith(2, identity);
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
