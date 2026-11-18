import { describe, expect, it, vi } from "vitest";
import { createMacExistingTerminalService } from "@desktop/main/chat-mac-terminal/existing-terminal-service";

const target = { chatId: "chat_origin", worktreeId: "wt_abcdef012345" };
const request = { ...target, requestId: "a454c167-8571-4ddf-861d-57e2ead091d4" };
const nextRequest = { ...target, requestId: "ef67f087-18b0-461c-9685-dfb955f186d9" };
const context = { ...target, projectId: "proj_test", scopeKey: "owner-scope" };
const terminal = { id: "t7", title: "Local test shell" };
const other = { id: "t8", title: "Other shell" };
const output = "approved local output\nonly from t7";

function setup() {
  const activity = { update: vi.fn(), finish: vi.fn() };
  const reader = {
    terminals: [terminal, other],
    read: vi.fn().mockResolvedValue(output),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    assertConnected: vi.fn(),
  };
  const lease = { check: vi.fn().mockResolvedValue(true), close: vi.fn() };
  const deps = {
    enabled: true,
    terminalBusy: vi.fn(() => false),
    readTerminalContext: vi.fn().mockResolvedValue(context),
    isTerminalContextCurrent: vi.fn(() => true),
    openReader: vi.fn().mockResolvedValue(reader),
    acquireActionPairing: vi.fn().mockResolvedValue(lease),
    beginActivity: vi.fn(() => activity),
  };
  const native = { sender: {}, isCurrent: vi.fn(() => true), pick: vi.fn().mockResolvedValue(terminal.id), approve: vi.fn().mockResolvedValue(true) };
  const service = createMacExistingTerminalService(deps);
  return { activity, native, reader, lease, deps, service, run: () => service.run(request, native) };
}

describe("read a selected existing Mac terminal", () => {
  it("returns the exact screen approved locally from the selected terminal", async () => {
    const { activity, deps, native, reader, lease, run } = setup();
    expect(await run()).toEqual({ status: "ready", terminalId: terminal.id, title: terminal.title, output });
    expect(native.pick).toHaveBeenCalledExactlyOnceWith(reader.terminals, expect.any(AbortSignal));
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(terminal.id, expect.any(AbortSignal));
    expect(native.approve).toHaveBeenCalledExactlyOnceWith(context, terminal, output, expect.any(AbortSignal));
    expect(reader.assertCurrent).toHaveBeenCalledWith(terminal.id, expect.any(AbortSignal));
    expect(deps.readTerminalContext.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [target, expect.any(AbortSignal)]),
    );
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("returned");
  });

  it("returns no output when the captured screen is declined", async () => {
    const { activity, native, reader, lease, run } = setup();
    native.approve.mockResolvedValue(false);
    expect(await run()).toEqual({ status: "declined" });
    expect(reader.read).toHaveBeenCalledOnce();
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("declined");
  });

  it("rejects a stale or forged picker result before reading the terminal", async () => {
    const { deps, native, reader, run } = setup();
    native.pick.mockResolvedValue("t999");
    expect(await run()).toEqual({ status: "unavailable" });
    expect(deps.acquireActionPairing).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
    expect(native.approve).not.toHaveBeenCalled();
  });

  it("requires the paired key before reading even after native selection", async () => {
    const { activity, deps, native, reader, run } = setup();
    deps.acquireActionPairing.mockResolvedValue(null);
    expect(await run()).toEqual({ status: "unavailable" });
    expect(native.pick).toHaveBeenCalledOnce();
    expect(reader.read).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it("does not release a snapshot if the registered worktree changed during approval", async () => {
    const { activity, deps, native, lease, run } = setup();
    native.approve.mockImplementationOnce(async () => {
      deps.readTerminalContext.mockResolvedValue({ ...context, worktreeId: "wt_abcdef012346" });
      return true;
    });
    expect(await run()).toEqual({ status: "unavailable" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("does not release a snapshot if the terminal closed or was replaced during approval", async () => {
    const { activity, native, reader, run } = setup();
    native.approve.mockImplementationOnce(async () => {
      reader.assertCurrent.mockRejectedValueOnce(new Error("terminal changed"));
      return true;
    });
    expect(await run()).toEqual({ status: "failed" });
    expect(activity.finish).toHaveBeenCalledWith("failed");
  });

  it("does not expose the snapshot if the pairing is revoked during approval", async () => {
    const { activity, deps, native, lease, run } = setup();
    deps.acquireActionPairing.mockImplementationOnce(async (operation: AbortController) => {
      native.approve.mockImplementationOnce(async () => { operation.abort("revoked"); return true; });
      return lease;
    });
    expect(await run()).toEqual({ status: "unavailable" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("rechecks the pairing after the final terminal validation before returning the snapshot", async () => {
    const { activity, reader, lease, run } = setup();
    reader.assertCurrent.mockImplementationOnce(async () => { lease.check.mockResolvedValue(false); });
    expect(await run()).toEqual({ status: "unavailable" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("discards an approved snapshot if the pinned terminal connection closes during the final pairing check", async () => {
    const { activity, reader, lease, run } = setup();
    const checking = Promise.withResolvers<void>();
    const pairingCurrent = Promise.withResolvers<boolean>();
    lease.check.mockResolvedValueOnce(true).mockImplementationOnce(() => {
      checking.resolve();
      return pairingCurrent.promise;
    });
    const result = run();
    await checking.promise;
    expect(reader.assertCurrent).toHaveBeenCalledExactlyOnceWith(terminal.id, expect.any(AbortSignal));
    reader.assertConnected.mockImplementation(() => { throw new Error("Local terminal connection changed"); });
    pairingCurrent.resolve(true);
    expect(await result).toEqual({ status: "failed" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("aborts only the original snapshot before a delayed reader can open the picker", async () => {
    const { service, deps, reader, native, run } = setup();
    const opening = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<typeof reader>();
    deps.openReader.mockImplementationOnce(() => { opening.resolve(); return opened.promise; });
    const pending = run();
    await opening.promise;

    try {
      const unrelated = [
        service.cancelRequest({ ...request, chatId: "chat_other" }, native.sender),
        service.cancelRequest({ ...request, worktreeId: "wt_abcdef012346" }, native.sender),
        service.cancelRequest(nextRequest, native.sender),
        service.cancelRequest(request, {}),
      ];
      const cancel = service.cancelRequest(request, native.sender);
      const overlap = service.run(nextRequest, native);
      opened.resolve(reader);
      expect(await Promise.all(unrelated)).toEqual([false, false, false, false]);
      expect(await overlap).toEqual({ status: "busy" });
      expect(await pending).toEqual({ status: "unavailable" });
      expect(await cancel).toBe(true);
      expect(native.pick).not.toHaveBeenCalled();
      expect(native.approve).not.toHaveBeenCalled();
      expect(reader.read).not.toHaveBeenCalled();
    } finally {
      opened.resolve(reader);
      await pending;
    }
  });

  it("dismisses native approval and ignores its late reply without canceling a later snapshot", async () => {
    const { service, native, lease, activity, run } = setup();
    const approval = Promise.withResolvers<AbortSignal>();
    const answer = Promise.withResolvers<boolean>();
    native.approve.mockImplementationOnce((_context, _terminal, _output, signal: AbortSignal) => {
      approval.resolve(signal);
      return answer.promise;
    });
    const pending = run();
    const originalSignal = await approval.promise;

    try {
      const cancel = service.cancelRequest(request, native.sender);
      expect(originalSignal.aborted).toBe(true);
      answer.resolve(true);
      expect(await pending).toEqual({ status: "unavailable" });
      expect(await cancel).toBe(true);
      expect(lease.close).toHaveBeenCalledOnce();
      expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
    } finally {
      answer.resolve(false);
      await pending;
    }

    const next = service.run(nextRequest, native);
    expect(await service.cancelRequest(request, native.sender)).toBe(false);
    expect(await next).toMatchObject({ status: "ready", output });
  });

  it("keeps cancellation scoped and blocks another request while the picker is active", async () => {
    const { native, reader, service, activity, run } = setup();
    let picking!: () => void;
    const pickerOpen = new Promise<void>(resolve => { picking = resolve; });
    native.pick.mockImplementationOnce(async (_entries, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
      picking();
    }));
    const first = run();
    await pickerOpen;
    expect(service.isBusy()).toBe(true);
    expect(await service.cancel("stopped", "chat_other")).toBe(false);
    expect(await run()).toEqual({ status: "busy" });
    expect(await service.cancel("stopped", target.chatId)).toBe(true);
    expect(await first).toEqual({ status: "unavailable" });
    expect(reader.read).not.toHaveBeenCalled();
    expect(service.isBusy()).toBe(false);
    expect(activity.finish).toHaveBeenCalledWith("stopped");
  });

  it("keeps the picker closed while an existing Mac terminal action is active", async () => {
    const { deps, run } = setup();
    deps.terminalBusy.mockReturnValue(true);
    expect(await run()).toEqual({ status: "busy" });
    expect(deps.openReader).not.toHaveBeenCalled();
  });
});
