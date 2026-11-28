import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMacTerminalBackgroundService } from "@desktop/main/chat-mac-terminal/background-service";
import {
  MacTerminalDeliveryRejectedError,
  type MacTerminalContext,
  type MacTerminalRequest,
} from "@desktop/main/chat-electron-preview/transport";
import type { MacTerminalProbeOutput } from "@desktop/shared/mac-terminal-probe";
import { MAC_TERMINAL_PROBE_INVOKE } from "@desktop/shared/mac-terminal-probe-ipc";
import { canSendBackgroundMacCheck } from "@desktop/renderer/src/features/chat/ChatMacTerminalProbe";

const context: MacTerminalContext = {
  chatId: "chat_test",
  projectId: "proj_test",
  worktreeId: "wt_test",
  scopeKey: "owner-computer",
};
const ref = { chatId: context.chatId, worktreeId: context.worktreeId };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const first = { id: "t1", run: vi.fn(async (): Promise<MacTerminalProbeOutput> => "Darwin"), dispose: vi.fn(async () => {}) };
  const second = { id: "t2", run: vi.fn(async (): Promise<MacTerminalProbeOutput> => "Darwin"), dispose: vi.fn(async () => {}) };
  const deps = {
    enabled: true,
    oneTimeBusy: vi.fn(() => false),
    approve: vi.fn(async (_context: MacTerminalContext, _signal: AbortSignal) => true),
    readTerminalContext: vi.fn(async () => context),
    isTerminalContextCurrent: vi.fn(() => true),
    isTerminalRequestCurrent: vi.fn(() => true),
    readBackgroundTerminalRequest: vi.fn<
      (context: MacTerminalContext, grant: { targetId: string; approvedAt: number }, signal: AbortSignal) =>
      Promise<MacTerminalRequest | null>
    >(async () => null),
    returnTerminalResult: vi.fn<
      (request: MacTerminalRequest, result: { terminalId: string; output: MacTerminalProbeOutput }, signal: AbortSignal) =>
      Promise<void>
    >(async () => {}),
    prepareTerminal: vi.fn(async () => first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second),
    tryBackgroundPreview: vi.fn<
      (context: MacTerminalContext, grant: { targetId: string; approvedAt: number }, signal: AbortSignal,
        beginPreview: () => boolean) => Promise<void>
    >(async () => {}),
    reportEvent: vi.fn(),
    onActiveChange: vi.fn(),
  };
  const service = createMacTerminalBackgroundService(deps);
  async function approve() {
    const grant = await service.start(ref);
    if (grant.status !== "ready") throw new Error("expected background permission");
    return grant;
  }
  function request(targetId: string, runId: string, overrides: Partial<MacTerminalRequest> = {}) {
    return { ...context, runId, targetId, action: "uname" as const, expiresAt: Date.now() + 60_000, ...overrides };
  }
  return { deps, first, second, service, approve, request };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("approved background Mac terminal checks", () => {
  it("dispatches one fixed system-checks batch in the approved scope and reuses its receipt on retry", async () => {
    const { deps, first, service, approve, request } = fixture();
    const { targetId } = await approve();
    const batch = request(targetId, "run_batch", { action: "system-checks" });
    const output = { kernel: "Darwin", architecture: "arm64", macOSVersion: "15.7.2" } as const;
    deps.readBackgroundTerminalRequest.mockResolvedValue(batch);
    deps.returnTerminalResult.mockRejectedValueOnce(new Error("retry delivery"));
    first.run.mockResolvedValue(output);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.run).toHaveBeenCalledOnce();
    expect(deps.prepareTerminal).toHaveBeenCalledExactlyOnceWith("system-checks");
    expect(deps.tryBackgroundPreview).not.toHaveBeenCalled();
    expect(deps.returnTerminalResult.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [batch, { terminalId: "t1", output }],
      [batch, { terminalId: "t1", output }],
    ]);
    expect(service.status(ref)).toMatchObject({ active: true, remaining: 2, phase: "waiting" });
    await service.stop();
  });

  it("passes a cancelable approval scope to preview discovery while no terminal work is pending", async () => {
    const { deps, service, approve } = fixture();
    deps.tryBackgroundPreview.mockImplementationOnce(async (_context, _grant, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const { targetId } = await approve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.tryBackgroundPreview).toHaveBeenCalledExactlyOnceWith(context, {
      targetId, approvedAt: expect.any(Number),
    }, expect.any(AbortSignal), expect.any(Function));
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
    expect(service.status(ref)).toMatchObject({ active: true, remaining: 3 });
    await service.stop();
    expect(deps.tryBackgroundPreview.mock.calls[0]?.[2].aborted).toBe(true);
  });

  it.each(["returns the result", "fails to return the result"])(
    "blocks a new Chat check during an admitted preview and reopens the grant when the preview %s", async outcome => {
      const { deps, service, approve } = fixture();
      const discovery = deferred<void>();
      const delivery = deferred<void>();
      deps.tryBackgroundPreview.mockImplementationOnce(async (_context, _grant, _signal, beginPreview) => {
        await discovery.promise;
        expect(beginPreview()).toBe(true);
        await delivery.promise;
        if (outcome === "fails to return the result") throw new Error("Preview delivery unavailable");
      });
      const channel = "chat:mac-terminal-background-status";
      vi.stubGlobal("window", { operator: { invoke: async (name: string, target: typeof ref) => {
        expect(name).toBe(channel);
        return MAC_TERMINAL_PROBE_INVOKE[channel].response.parse(service.status(target));
      } } });
      const { targetId } = await approve();
      const canSend = () => canSendBackgroundMacCheck(ref.chatId, ref.worktreeId, targetId);

      await vi.advanceTimersByTimeAsync(0);
      expect(deps.tryBackgroundPreview).toHaveBeenCalledOnce();
      await expect(canSend()).resolves.toBe(true);

      discovery.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await expect(canSend()).resolves.toBe(false);

      delivery.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await expect(canSend()).resolves.toBe(true);
      expect(service.status(ref)).toMatchObject({ active: true, remaining: 3 });
      await service.stop();
    },
  );

  it("does not overlap a one-time approval or a second background request", async () => {
    const { deps, service } = fixture();
    deps.oneTimeBusy.mockReturnValueOnce(true);
    expect(await service.start(ref)).toEqual({ status: "busy" });
    expect(deps.approve).not.toHaveBeenCalled();
    const consent = deferred<boolean>();
    deps.approve.mockReturnValueOnce(consent.promise);
    const pending = service.start(ref);
    expect(await service.start(ref)).toEqual({ status: "busy" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.approve).toHaveBeenCalledOnce();
    await service.stop();
    expect(deps.approve.mock.calls[0]?.[1].aborted).toBe(true);
    consent.resolve(true);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(deps.readBackgroundTerminalRequest).not.toHaveBeenCalled();
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
  });

  it("records a bounded diagnostic for approval errors without leaking their messages", async () => {
    const { deps, service } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.approve.mockRejectedValueOnce(new Error("private approval details"));

    try {
      expect(await service.start(ref)).toEqual({ status: "failed" });
      expect(deps.reportEvent).toHaveBeenCalledExactlyOnceWith("failed", "approval-failed");
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "[chat-mac-terminal-background]", "approval-failed", "Error",
      );
      expect(service.isBusy()).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  it("polls and returns two distinct checks after one approval without a renderer dispatch", async () => {
    const { deps, first, second, service, approve, request } = fixture();
    const grant = await approve();
    const one = request(grant.targetId, "run_1");
    deps.readBackgroundTerminalRequest.mockResolvedValue(one);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.returnTerminalResult).toHaveBeenCalledExactlyOnceWith(one, { terminalId: "t1", output: "Darwin" }, expect.any(AbortSignal));
    expect(first.run).toHaveBeenCalledOnce();
    expect(service.status(ref)).toMatchObject({ active: true, remaining: 2, phase: "waiting" });

    const two = request(grant.targetId, "run_2");
    deps.readBackgroundTerminalRequest.mockResolvedValue(two);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.returnTerminalResult).toHaveBeenNthCalledWith(2, two, { terminalId: "t2", output: "Darwin" }, expect.any(AbortSignal));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.run).toHaveBeenCalledOnce();
    expect(deps.approve).toHaveBeenCalledOnce();
    expect(service.status(ref)).toMatchObject({ active: true, targetId: grant.targetId, remaining: 1, phase: "waiting" });
    expect(deps.reportEvent.mock.calls.map(([event]) => event)).toEqual([
      "approved", "dispatched", "returned", "dispatched", "returned",
    ]);
    await service.stop();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(deps.onActiveChange.mock.calls).toEqual([[true], [false]]);
  });

  it("reports one diagnostic per discovery failure episode and recovers within the same grant", async () => {
    const { deps, first, service, approve, request } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { targetId } = await approve();
    const next = request(targetId, "run_1");
    deps.readBackgroundTerminalRequest
      .mockRejectedValueOnce(new Error("private connection details"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(next)
      .mockRejectedValueOnce(new Error("offline again"));

    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(deps.readBackgroundTerminalRequest).toHaveBeenCalledTimes(2);
      expect(deps.reportEvent.mock.calls).toEqual([["approved"], ["failed", "transport-failed"]]);
      expect(warning).toHaveBeenCalledExactlyOnceWith("[chat-mac-terminal-background]", "transport-failed", "Error");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deps.approve).toHaveBeenCalledOnce();
      expect(first.run).toHaveBeenCalledOnce();
      expect(deps.returnTerminalResult).toHaveBeenCalledExactlyOnceWith(next, { terminalId: "t1", output: "Darwin" }, expect.any(AbortSignal));
      expect(service.status(ref)).toMatchObject({ active: true, targetId, remaining: 2, phase: "waiting" });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(deps.reportEvent.mock.calls).toEqual([
        ["approved"], ["failed", "transport-failed"], ["dispatched"], ["returned"], ["failed", "transport-failed"],
      ]);
      expect(warning.mock.calls).toEqual([
        ["[chat-mac-terminal-background]", "transport-failed", "Error"],
        ["[chat-mac-terminal-background]", "transport-failed", "Error"],
      ]);
      expect(first.run).toHaveBeenCalledOnce();
      expect(deps.returnTerminalResult).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      await service.stop();
    }
  });

  it("retries only the identical result after ambiguous delivery", async () => {
    const { deps, first, service, approve, request } = fixture();
    const { targetId } = await approve();
    const next = request(targetId, "run_1");
    deps.readBackgroundTerminalRequest.mockResolvedValue(next);
    deps.returnTerminalResult.mockRejectedValueOnce(new Error("connection went away after write"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.status(ref)).toMatchObject({ active: true, phase: "returning", remaining: 2 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deps.returnTerminalResult).toHaveBeenCalledTimes(2);
    expect(deps.returnTerminalResult.mock.calls[0]?.slice(0, 2)).toEqual(deps.returnTerminalResult.mock.calls[1]?.slice(0, 2));
    expect(first.run).toHaveBeenCalledOnce();
    expect(deps.prepareTerminal).toHaveBeenCalledOnce();
    expect(deps.reportEvent.mock.calls).toEqual([["approved"], ["dispatched"], ["failed", "transport-failed"], ["returned"]]);
    await service.stop();
  });

  it("drops a rejected result without replaying its command or blocking later checks", async () => {
    const { deps, first, second, service, approve, request } = fixture();
    const { targetId } = await approve();
    const one = request(targetId, "run_1");
    deps.readBackgroundTerminalRequest.mockResolvedValue(one);
    deps.returnTerminalResult.mockRejectedValueOnce(new MacTerminalDeliveryRejectedError("Chat has moved on"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.status(ref)).toMatchObject({ active: true, remaining: 2, phase: "waiting" });
    expect(deps.reportEvent).toHaveBeenCalledWith("failed", "delivery-rejected");
    expect(deps.returnTerminalResult).toHaveBeenCalledOnce();
    expect(first.run).toHaveBeenCalledOnce();

    const two = request(targetId, "run_2");
    deps.readBackgroundTerminalRequest.mockResolvedValue(two);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.returnTerminalResult).toHaveBeenCalledTimes(2);
    expect(deps.returnTerminalResult).toHaveBeenLastCalledWith(two, { terminalId: "t2", output: "Darwin" }, expect.any(AbortSignal));
    expect(second.run).toHaveBeenCalledOnce();
    expect(deps.approve).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("rejects foreign and expired candidate scopes before allocating a terminal", async () => {
    const { deps, service, approve, request } = fixture();
    const { targetId } = await approve();
    for (const bad of [
      { chatId: "chat_other" }, { worktreeId: "wt_other" }, { projectId: "proj_other" },
      { scopeKey: "different-owner" }, { targetId: "00000000-0000-4000-8000-000000000000" },
      { expiresAt: Date.now() - 1 },
    ]) {
      deps.readBackgroundTerminalRequest.mockResolvedValue(request(targetId, "run_wrong", bad));
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(deps.prepareTerminal).not.toHaveBeenCalled();
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
    expect(service.status({ ...ref, worktreeId: "wt_other" })).toEqual({ active: false });
    expect(await service.cancel("chat_other")).toBe(false);
    expect(service.status(ref)).toMatchObject({ active: true, remaining: 3 });
    await service.stop();
  });

  it("never polls concurrently while a discovery request is pending", async () => {
    const { deps, service, approve } = fixture();
    const waiting = deferred<MacTerminalRequest | null>();
    deps.readBackgroundTerminalRequest.mockReturnValue(waiting.promise);
    await approve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.readBackgroundTerminalRequest).toHaveBeenCalledOnce();
    waiting.resolve(null);
    await service.stop();
  });

  it("disposes a terminal that became available after the user stopped the grant", async () => {
    const { deps, first, service, approve, request } = fixture();
    const waiting = deferred<typeof first>();
    deps.prepareTerminal.mockReset().mockReturnValue(waiting.promise);
    const { targetId } = await approve();
    deps.readBackgroundTerminalRequest.mockResolvedValue(request(targetId, "run_1"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.prepareTerminal).toHaveBeenCalledOnce();
    const stopped = service.stop();
    expect(service.status(ref)).toEqual({ active: false });
    waiting.resolve(first);
    await stopped;
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.run).not.toHaveBeenCalled();
    expect(deps.returnTerminalResult).not.toHaveBeenCalled();
  });

  it("aborts in-flight result delivery when stopped and never retries it", async () => {
    const { deps, first, service, approve, request } = fixture();
    deps.returnTerminalResult.mockImplementation((_request, _result, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const { targetId } = await approve();
    deps.readBackgroundTerminalRequest.mockResolvedValue(request(targetId, "run_1"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.status(ref)).toMatchObject({ active: true, phase: "returning" });
    await service.stop();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(deps.returnTerminalResult.mock.calls[0]?.[2].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.returnTerminalResult).toHaveBeenCalledOnce();
  });

  it("revokes on account change or expiry and stops polling", async () => {
    const { deps, service, approve } = fixture();
    const grant = await approve();
    await vi.advanceTimersByTimeAsync(1000);
    deps.isTerminalContextCurrent.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.status(ref)).toEqual({ active: false });
    expect(deps.onActiveChange.mock.calls).toEqual([[true], [false]]);
    deps.isTerminalContextCurrent.mockReturnValue(true);
    const next = await approve();
    expect(next.targetId).not.toBe(grant.targetId);
    await vi.advanceTimersByTimeAsync(next.expiresAt - Date.now());
    expect(service.status(ref)).toEqual({ active: false });
    expect(deps.reportEvent.mock.calls.map(([event]) => event)).toEqual(["approved", "revoked", "approved", "revoked"]);
  });

  it("limits one approval to three runs and releases each dedicated terminal", async () => {
    const { deps, service, approve, request } = fixture();
    const { targetId } = await approve();
    const terminals = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      run: vi.fn(async () => "Darwin" as const),
      dispose: vi.fn(async () => {}),
    }));
    deps.prepareTerminal.mockReset().mockImplementation(() => {
      const terminal = terminals[deps.prepareTerminal.mock.calls.length - 1];
      if (!terminal) throw new Error("unexpected execution beyond approved capacity");
      return Promise.resolve(terminal);
    });
    for (let i = 1; i <= 4; i++) {
      deps.readBackgroundTerminalRequest.mockResolvedValue(request(targetId, `run_${i}`));
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(deps.prepareTerminal).toHaveBeenCalledTimes(3);
    expect(deps.returnTerminalResult).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.status(ref)).toEqual({ active: false });
    expect(terminals.every(terminal => terminal.dispose.mock.calls.length === 1)).toBe(true);
  });
});
