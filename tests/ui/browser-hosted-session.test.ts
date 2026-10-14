import { describe, expect, it, vi } from "vitest";
import { createHostedBrowserSession } from "../../packages/ui/src/browser/hosted-session";
describe("native hosted browser session renewal", () => {
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
