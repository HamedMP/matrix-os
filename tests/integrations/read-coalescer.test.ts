import { describe, expect, it, vi } from "vitest";
import { createReadCoalescer, proxyReadKey } from "../../packages/gateway/src/integrations/read-coalescer.js";
describe("bounded read coalescing", () => {
  it("drops rejected reads so retrying can succeed", async () => {
    const coalesce = createReadCoalescer(); const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("fresh");
    await expect(coalesce("same", read)).rejects.toThrow("offline");
    expect(await coalesce("same", read)).toBe("fresh");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("evicts oldest active entries at the cap without interfering with newer requests", async () => {
    const coalesce = createReadCoalescer(1); let finish!: (value: string) => void;
    const first = coalesce("a", () => new Promise<string>(resolve => { finish = resolve; }));
    await Promise.resolve();
    const second = coalesce("b", async () => "b");
    expect(await coalesce("a", async () => "new-a")).toBe("new-a");
    finish("old-a"); expect(await first).toBe("old-a"); expect(await second).toBe("b");
  });
  it("expires stale in-flight entries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const coalesce = createReadCoalescer(2, 100);
    const old = coalesce("a", async () => new Promise(() => {}));
    now.mockReturnValue(200);
    expect(await coalesce("a", async () => "fresh")).toBe("fresh");
    now.mockRestore(); void old;
  });
  it("keys owner, account, URL, parameters, and headers without depending on object order", () => {
    const a = { externalUserId: "owner", accountId: "account", url: "https://example.com", params: { a: "1", b: "2" }, headers: { Accept: "application/json" } };
    expect(proxyReadKey(a)).toBe(proxyReadKey({ ...a, params: { b: "2", a: "1" } }));
    for (const change of [{ externalUserId: "other" }, { accountId: "other" }, { url: "https://other.example.com" }, { params: { a: "2" } }, { headers: { Accept: "text/plain" } }]) {
      expect(proxyReadKey({ ...a, ...change })).not.toBe(proxyReadKey(a));
    }
  });
});
