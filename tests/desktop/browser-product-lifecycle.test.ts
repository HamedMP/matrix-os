import { describe, expect, it, vi } from "vitest";
import { createBrowserProductLifecycle } from "@desktop/main/embeds/browser-product-lifecycle";
const origin = "https://gateway.test";
const launch = `${origin}/apps/browser-lab/?session=synthetic&surface=browser`;
function setup() {
  let url = "about:blank";
  const contents = { getURL: () => url, isDestroyed: () => false, loadURL: vi.fn(async next => { url = next; }), executeJavaScript: vi.fn(async () => {}) };
  const renew = vi.fn(async () => {}); const refreshAdmission = vi.fn(); const revokeAdmission = vi.fn();
  const lifecycle = createBrowserProductLifecycle({ contents, origin, renew, refreshAdmission, revokeAdmission });
  return { lifecycle, contents, renew, refreshAdmission, revokeAdmission, url: (value: string) => { url = value; } };
}
describe("native product view lifecycle", () => {
  it("uses launch token once, then renews cookie/admission and reloads the canonical product URL", async () => {
    const f = setup(); await f.lifecycle.loadUrl(launch);
    expect(f.contents.loadURL).toHaveBeenLastCalledWith(launch);
    expect(f.renew).not.toHaveBeenCalled();
    await f.lifecycle.loadUrl(launch);
    expect(f.renew).toHaveBeenCalledOnce();
    expect(f.refreshAdmission).toHaveBeenCalledTimes(2);
    expect(f.contents.loadURL).toHaveBeenLastCalledWith(`${origin}/apps/browser-lab/?surface=browser`);
  });
  it("posts only bounded self-source visibility messages after load and active changes", async () => {
    const f = setup(); f.lifecycle.setActive(true); await f.lifecycle.loadUrl(launch); f.lifecycle.ready();
    expect(f.contents.executeJavaScript).toHaveBeenLastCalledWith('void window.postMessage({"type":"matrix-browser-visibility","active":true},"https://gateway.test")');
    f.lifecycle.setActive(false);
    expect(f.contents.executeJavaScript).toHaveBeenLastCalledWith('void window.postMessage({"type":"matrix-browser-visibility","active":false},"https://gateway.test")');
    f.url("https://attacker.test/apps/browser-lab/"); f.lifecycle.setActive(true);
    expect(f.contents.executeJavaScript).toHaveBeenCalledTimes(2);
  });
  it("fails reload closed before navigation on renewal failure and revokes on close", async () => {
    const f = setup(); await f.lifecycle.loadUrl(launch); f.renew.mockRejectedValue(new Error("unavailable"));
    await expect(f.lifecycle.loadUrl(launch)).rejects.toThrow();
    expect(f.contents.loadURL).toHaveBeenCalledOnce(); f.lifecycle.close(); expect(f.revokeAdmission).toHaveBeenCalledOnce();
  });
});
