import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacTerminalWatch } from "@desktop/main/chat-mac-terminal/watch-existing-terminal-service";

const target = { chatId: "chat_original", worktreeId: "wt_abcdef012345" };
const context = { ...target, projectId: "proj_test", scopeKey: "owner-and-computer" };
const selected = { id: "t7", title: "Selected Terminal" };
const other = { id: "t8", title: "Another Terminal" };

function setup() {
  const activity = { update: vi.fn(), finish: vi.fn() };
  const reader = {
    terminals: [selected, other],
    read: vi.fn().mockResolvedValue("First screen from t7"),
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
    reportError: vi.fn(),
  };
  let closeSender: (() => void) | undefined;
  const removeSenderListener = vi.fn();
  const native = {
    sender: {},
    isCurrent: vi.fn(() => true),
    pick: vi.fn().mockResolvedValue(selected.id),
    approve: vi.fn().mockResolvedValue(true),
    onClose(handler: () => void) {
      closeSender = handler;
      return removeSenderListener;
    },
  };
  const service = createMacTerminalWatch(deps);
  const start = () => service.start(target, native);
  async function ready() {
    const result = await start();
    if (result.status !== "ready") throw new Error("Expected watch approval");
    return { ...target, watchId: result.watchId };
  }
  return {
    deps, reader, lease, native, activity, service, start, ready, removeSenderListener,
    closeSender: () => closeSender?.(),
  };
}

afterEach(() => vi.useRealTimers());

describe("watch an existing Mac Terminal", () => {
  it("reads only the approved existing Terminal and replaces its visible screen after the first read", async () => {
    const { service, start, native, deps, reader, activity, lease } = setup();
    const result = await start();
    expect(result).toEqual({
      status: "ready", watchId: expect.any(String), terminalId: selected.id,
      title: selected.title, expiresAt: expect.any(Number), output: "First screen from t7",
    });
    if (result.status !== "ready") throw new Error("Expected watch approval");
    expect(native.pick).toHaveBeenCalledExactlyOnceWith(reader.terminals, expect.any(AbortSignal));
    expect(native.approve).toHaveBeenCalledExactlyOnceWith(context, selected, expect.any(AbortSignal));
    expect(native.approve.mock.invocationCallOrder[0]!).toBeLessThan(reader.read.mock.invocationCallOrder[0]!);

    const ref = { ...target, watchId: result.watchId };
    reader.read.mockResolvedValueOnce("Second screen from t7");
    expect(await service.read(ref, native.sender)).toEqual({ status: "ready", output: "Second screen from t7" });
    expect(reader.read.mock.calls.map(args => args[0])).toEqual([selected.id, selected.id]);
    expect(deps.beginActivity).toHaveBeenCalledWith("terminal-watch", target.worktreeId);
    expect(service.isBusy()).toBe(true);
    expect(await service.stop(ref, native.sender)).toEqual({ ok: true });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(service.isBusy()).toBe(false);
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
  });

  it("rejects a foreign Chat, worktree, watch ID or renderer and leaves the owner able to stop", async () => {
    const { service, ready, native, reader } = setup();
    const ref = await ready();
    for (const wrong of [
      { ...ref, chatId: "chat_elsewhere" },
      { ...ref, worktreeId: "wt_abcdef012346" },
      { ...ref, watchId: "7105cb6e-0521-4f68-a6b3-729916a5e31d" },
    ]) {
      expect(await service.read(wrong, native.sender)).toEqual({ status: "ended" });
      expect(await service.stop(wrong, native.sender)).toEqual({ ok: false });
    }
    expect(await service.read(ref, {})).toEqual({ status: "ended" });
    expect(await service.stop(ref, {})).toEqual({ ok: false });
    expect(reader.read).toHaveBeenCalledOnce();
    expect(await service.stop(ref, native.sender)).toEqual({ ok: true });
  });

  it("keeps cancellation scoped, drains the pending read and discards a late result", async () => {
    const { service, ready, start, native, reader, activity } = setup();
    const ref = await ready();
    const reading = Promise.withResolvers<void>();
    const screen = Promise.withResolvers<string>();
    reader.read.mockImplementationOnce(() => { reading.resolve(); return screen.promise; });

    const result = service.read(ref, native.sender);
    await reading.promise;
    expect(await service.read(ref, native.sender)).toEqual({ status: "busy" });
    expect(await service.cancel("stopped", "chat_elsewhere")).toBe(false);
    const stopping = service.stop(ref, native.sender);
    expect(await start()).toEqual({ status: "busy" });
    screen.resolve("Output captured before stop acknowledgement");
    expect(await result).toEqual({ status: "ended" });
    expect(await stopping).toEqual({ ok: true });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(service.isBusy()).toBe(false);
  });

  it("does not deliver a read after the original Chat loses its registered worktree", async () => {
    const { service, ready, native, reader, deps, activity } = setup();
    const ref = await ready();
    reader.read.mockImplementationOnce(async () => {
      deps.readTerminalContext.mockResolvedValue({ ...context, projectId: "proj_reassigned" });
      return "Screen taken before placement change";
    });
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
    expect(service.isBusy()).toBe(false);
  });

  it("checks the device pairing after the final Terminal identity inspection", async () => {
    const { service, ready, native, reader, lease, activity } = setup();
    const ref = await ready();
    reader.assertCurrent.mockImplementationOnce(async () => { lease.check.mockResolvedValue(false); });
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it("discards captured output if the Herdr connection closes while pairing is rechecked", async () => {
    const { service, ready, native, reader, lease, activity } = setup();
    const ref = await ready();
    lease.check.mockImplementationOnce(async () => {
      reader.assertConnected.mockImplementation(() => { throw new Error("Local terminal connection changed"); });
      return true;
    });
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("failed");
    expect(service.isBusy()).toBe(false);
  });

  it("ends the watch on the original Terminal's disconnect and requires a new native approval", async () => {
    const { service, ready, start, native, reader, activity, lease } = setup();
    const ref = await ready();
    reader.read.mockRejectedValueOnce(new Error("Local terminal connection changed"));
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("failed");
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    native.pick.mockResolvedValueOnce(other.id);
    expect(await start()).toMatchObject({ status: "ready", terminalId: other.id });
    expect(native.approve).toHaveBeenLastCalledWith(context, other, expect.any(AbortSignal));
    await service.cancel("stopped");
  });

  it("releases the lease and removes native listeners when the originating renderer closes", async () => {
    const { service, ready, native, activity, lease, closeSender, removeSenderListener } = setup();
    const ref = await ready();
    closeSender();
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(removeSenderListener).toHaveBeenCalledOnce();
    expect(lease.close).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it("never acquires pairing or reads a screen without local consent", async () => {
    const { service, start, native, deps, reader, activity } = setup();
    native.approve.mockResolvedValueOnce(false);
    expect(await start()).toEqual({ status: "declined" });
    expect(deps.acquireActionPairing).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("declined");
    expect(service.isBusy()).toBe(false);
  });

  it("honors the finite approved window and rate limits terminal reads", async () => {
    vi.useFakeTimers();
    const { service, start, native, reader, activity } = setup();
    const now = Date.now();
    const result = await start();
    if (result.status !== "ready") throw new Error("Expected watch approval");
    expect(result.expiresAt).toBe(now + 300_000);
    const ref = { ...target, watchId: result.watchId };
    reader.read.mockResolvedValueOnce("");
    expect(await service.read(ref, native.sender)).toEqual({ status: "ready", output: "" });
    expect(await service.read(ref, native.sender)).toEqual({ status: "busy" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await service.read(ref, native.sender)).toEqual({ status: "ready", output: "First screen from t7" });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(await service.read(ref, native.sender)).toEqual({ status: "ended" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("expired");
    expect(service.isBusy()).toBe(false);
  });
});
