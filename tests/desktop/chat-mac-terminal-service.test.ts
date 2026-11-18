import { describe, expect, it, vi } from "vitest";
import type { MacActionPairing } from "@desktop/main/desktop-pairing/action";
import { createChatMacTerminalService } from "@desktop/main/chat-mac-terminal/service";

const context = { chatId: "chat_origin", projectId: "proj_test", worktreeId: "wt_test", scopeKey: "owner-scope" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(acquireActionPairing?: MacActionPairing) {
  const terminal = { id: "t7", run: vi.fn().mockResolvedValue("Darwin"), dispose: vi.fn().mockResolvedValue(undefined) };
  const activity = { update: vi.fn(), finish: vi.fn() };
  const deps = {
    enabled: true,
    acquireActionPairing,
    readTerminalContext: vi.fn().mockResolvedValue(context),
    isTerminalContextCurrent: vi.fn(() => true),
    readTerminalRequest: vi.fn(),
    isTerminalRequestCurrent: vi.fn(() => true),
    returnTerminalResult: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(true),
    prepareTerminal: vi.fn().mockResolvedValue(terminal),
    beginActivity: vi.fn(() => activity),
  };
  const service = createChatMacTerminalService(deps);
  async function prepare() {
    const prepared = await service.prepare({ chatId: context.chatId, worktreeId: context.worktreeId });
    if (prepared.status !== "ready") throw new Error("expected a ready terminal");
    deps.readTerminalRequest.mockResolvedValue({ ...context, runId: "run_probe",
      targetId: prepared.targetId, action: "uname", expiresAt: prepared.expiresAt });
    return prepared;
  }
  return { service, deps, activity, terminal, prepare };
}

describe("approved Matrix Chat Mac terminal grant", () => {
  it("requires the paired key after consent before preparing a terminal", async () => {
    const acquireActionPairing = vi.fn(async () => null);
    const { activity, deps, service } = setup(acquireActionPairing);
    expect(await service.prepare(context)).toEqual({ status: "unavailable" });
    expect(deps.approve).toHaveBeenCalledOnce();
    expect(acquireActionPairing).toHaveBeenCalledOnce();
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("disposes an idle terminal immediately when its pairing is revoked", async () => {
    const close = vi.fn();
    const { promise: acquired, resolve } = deferred<AbortController>();
    const { activity, service, terminal, prepare } = setup(async operation => {
      resolve(operation);
      return { check: vi.fn().mockResolvedValue(true), close };
    });
    await prepare();
    const operation = await acquired;
    operation.abort("revoked");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    expect(terminal.run).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledWith("revoked");
  });

  it("checks the device again before sending terminal output", async () => {
    const { promise: acquired, resolve } = deferred<AbortController>();
    const check = vi.fn().mockResolvedValue(true);
    const { deps, service, terminal, prepare } = setup(async operation => {
      resolve(operation);
      return { check, close: vi.fn() };
    });
    await prepare();
    const operation = await acquired;
    terminal.run.mockImplementationOnce(async () => {
      check.mockImplementationOnce(async () => { operation.abort("revoked"); return false; });
      return "Darwin";
    });
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
  });

  it("prepares one dedicated terminal and dispatches and returns without a second approval", async () => {
    const { deps, activity, service, terminal, prepare } = setup();
    const grant = await prepare();
    expect(grant.terminalId).toBe("t7");
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "returned" });
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(terminal.run).toHaveBeenCalledTimes(1);
    expect(deps.returnTerminalResult).toHaveBeenCalledWith(expect.objectContaining({ targetId: grant.targetId }),
      { terminalId: "t7", output: "Darwin" }, expect.any(AbortSignal));
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "already-handled" });
    await service.cancelAll();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(deps.beginActivity).toHaveBeenCalledExactlyOnceWith("terminal", context.worktreeId);
    expect(activity.update.mock.calls.flat()).toEqual(["awaiting-approval", "ready", "running", "returning"]);
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("returned");
  });

  it("never creates a terminal if the native approval is declined", async () => {
    const { deps, activity, service } = setup();
    deps.approve.mockResolvedValue(false);
    expect(await service.prepare({ chatId: context.chatId, worktreeId: context.worktreeId })).toEqual({ status: "declined" });
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("declined");
  });

  it("aborts the foreground terminal result when the native Stop is used during delivery", async () => {
    const { deps, activity, service, terminal, prepare } = setup();
    await prepare();
    let signalAtDelivery!: AbortSignal;
    let start = () => {};
    const returning = new Promise<void>(resolve => { start = resolve; });
    deps.returnTerminalResult.mockImplementation((_request, _result, signal?: AbortSignal) => {
      signalAtDelivery = signal!;
      start();
      if (!signal) throw new Error("expected a cancelable terminal delivery");
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const run = service.run({ chatId: context.chatId, runId: "run_probe" });
    await returning;
    await service.cancelAll("stopped");
    expect(await run).toEqual({ status: "unavailable" });
    expect(signalAtDelivery.aborted).toBe(true);
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(terminal.run).toHaveBeenCalledOnce();
  });

  it("waits for a terminal allocated after Stop and its disposal before completing", async () => {
    const { deps, activity, service, terminal } = setup();
    const allocationStarted = deferred<void>();
    const allocate = deferred<typeof terminal>();
    const disposalStarted = deferred<void>();
    const dispose = deferred<void>();
    deps.prepareTerminal.mockImplementation(async () => {
      allocationStarted.resolve();
      return allocate.promise;
    });
    terminal.dispose.mockImplementation(async () => {
      disposalStarted.resolve();
      return dispose.promise;
    });
    const preparation = service.prepare(context);
    await allocationStarted.promise;
    const settled = vi.fn();
    const stopped = service.cancelAll("stopped").then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    allocate.resolve(terminal);
    await disposalStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    dispose.resolve();
    await stopped;
    expect(await preparation).toEqual({ status: "unavailable" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(terminal.run).not.toHaveBeenCalled();
  });

  it("waits for active terminal execution and disposal to settle across simultaneous cancel calls", async () => {
    const { deps, activity, service, terminal, prepare } = setup();
    await prepare();
    const started = deferred<AbortSignal>();
    const execute = deferred<string>();
    terminal.run.mockImplementation(async (signal: AbortSignal) => {
      started.resolve(signal);
      return execute.promise;
    });
    const run = service.run({ chatId: context.chatId, runId: "run_probe" });
    const signal = await started.promise;
    const settled = vi.fn();
    const stopped = service.cancel(context.chatId).then(settled);
    const stoppedAgain = service.cancelAll("stopped").then(settled);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(await service.prepare(context)).toEqual({ status: "busy" });
    execute.resolve("Darwin");
    await Promise.all([stopped, stoppedAgain]);
    expect(await run).toEqual({ status: "unavailable" });
    expect(activity.finish).toHaveBeenCalledExactlyOnceWith("stopped");
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
  });

  it("rejects a different target, owner scope or worktree before the terminal receives input", async () => {
    const { deps, service, terminal, prepare } = setup();
    const grant = await prepare();
    const request = { ...context, runId: "run_probe", targetId: grant.targetId,
      action: "uname", expiresAt: grant.expiresAt };
    for (const change of [{ targetId: "other" }, { scopeKey: "another" }, { worktreeId: "wt_another" },
      { action: "unexpected" }, { expiresAt: Date.now() - 10 }]) {
      deps.readTerminalRequest.mockResolvedValue({ ...request, ...change });
      expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    }
    expect(terminal.run).not.toHaveBeenCalled();
    await service.cancelAll();
  });

  it("revokes a reservation on authority loss and never returns output from the canceled run", async () => {
    const { deps, service, terminal, prepare } = setup();
    await prepare();
    deps.isTerminalContextCurrent.mockReturnValue(false);
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "unavailable" });
    expect(terminal.run).not.toHaveBeenCalled();
    await service.cancelAll();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
  });

  it("does not dispatch again when return delivery fails", async () => {
    const { deps, service, terminal, prepare } = setup();
    await prepare();
    deps.returnTerminalResult.mockRejectedValueOnce(new Error("connection failed"));
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "failed" });
    expect(await service.run({ chatId: context.chatId, runId: "run_probe" })).toEqual({ status: "already-handled" });
    expect(terminal.run).toHaveBeenCalledTimes(1);
    await service.cancelAll();
  });
});
