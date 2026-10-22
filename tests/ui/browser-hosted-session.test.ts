import { describe, expect, it, vi } from "vitest";
import { createHostedBrowserSession } from "../../packages/ui/src/browser/hosted-session";
describe("native hosted browser session renewal", () => {
  it("forces fresh owner admission on reconnect before the automatic renewal boundary", async () => {
    const renew = vi.fn(async () => {});
    const ensure = createHostedBrowserSession(renew, () => 0);
    await ensure(new AbortController().signal);
    expect(renew).not.toHaveBeenCalled();
    await ensure(new AbortController().signal, { force: true });
    expect(renew).toHaveBeenCalledOnce();
    await ensure(new AbortController().signal);
    expect(renew).toHaveBeenCalledOnce();
  });
  it("shares concurrent forced admission and retries a failed reconnect", async () => {
    let release!: () => void;
    const renew = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const ensure = createHostedBrowserSession(renew, () => 0);
    const first = ensure(new AbortController().signal, { force: true });
    const second = ensure(new AbortController().signal, { force: true });
    let regularFinished = false;
    const regular = ensure(new AbortController().signal).then(() => { regularFinished = true; });
    await Promise.resolve();
    expect(regularFinished).toBe(false);
    expect(renew).toHaveBeenCalledOnce();
    release(); await Promise.all([first, second, regular]);
    renew.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(ensure(new AbortController().signal, { force: true })).rejects.toThrow();
    const retry = ensure(new AbortController().signal, { force: true });
    release(); await retry;
    expect(renew).toHaveBeenCalledTimes(3);
  });
  it("keeps shared renewal alive when its initiating caller aborts", async () => {
    let now = 0; let release!: () => void; let renewalSignal!: AbortSignal;
    const renew = vi.fn((signal: AbortSignal) => { renewalSignal = signal; return new Promise<void>(resolve => { release = resolve; }); });
    const ensure = createHostedBrowserSession(renew, () => now); now = 480_000;
    const first = new AbortController();
    const abandoned = ensure(first.signal); const rejected = expect(abandoned).rejects.toThrow();
    first.abort(); const next = ensure(new AbortController().signal);
    expect(renewalSignal.aborted).toBe(false);
    release(); await rejected; await expect(next).resolves.toBeUndefined();
    await ensure(new AbortController().signal); expect(renew).toHaveBeenCalledOnce();
  });
  it("uses the signed launch cookie initially and renews before ten minutes", async () => {
    let now = 0; const renew = vi.fn(async () => {});
    const ensure = createHostedBrowserSession(renew, () => now);
    await ensure(new AbortController().signal); expect(renew).not.toHaveBeenCalled();
    now = 480_000; await ensure(new AbortController().signal); expect(renew).toHaveBeenCalledOnce();
    await ensure(new AbortController().signal); expect(renew).toHaveBeenCalledOnce();
  });
  it("does not mark failed renewal as complete and rejects aborted lifetimes", async () => {
    let now = 0; const renew = vi.fn(async () => { throw new Error("Unavailable"); });
    const ensure = createHostedBrowserSession(renew, () => now); now = 480_000;
    await expect(ensure(new AbortController().signal)).rejects.toThrow();
    await expect(ensure(new AbortController().signal)).rejects.toThrow(); expect(renew).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort();
    await expect(ensure(controller.signal)).rejects.toThrow(); expect(renew).toHaveBeenCalledTimes(2);
  });
});
