import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { buildMobileAppBridgeScript, createMobileAppCapabilityBroker } from "../../apps/mobile/lib/app-capability-bridge";
const runtime = "https://app.matrix-os.com/apps/app-gallery/?session=fixture";
const brokers: ReturnType<typeof createMobileAppCapabilityBroker>[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });
function setup(app = "app-gallery") {
  const request = vi.fn(async () => new Response(JSON.stringify({ enabled: true, reviewer: false, signingKeys: [] })));
  const reply = vi.fn(); const openApp = vi.fn(async () => {});
  const url = runtime.replace("/app-gallery/", `/${app}/`);
  const broker = createMobileAppCapabilityBroker({ app, runtimeUrl: url, launchId: "launch", request, reply, openApp });
  brokers.push(broker);
  const receive = (kind: string, input: unknown, id = 1) => broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id, kind, input }), url);
  return { request, reply, openApp, broker, receive, ready: () => broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), url) };
}
describe("Native Mobile Gallery bridge", () => {
  it("allows exact store routes for verified Gallery identity only", async () => {
    const gallery = setup(); await gallery.ready(); await gallery.receive("gateway", { url: "/api/app-store/status", method: "GET" });
    expect(gallery.request).toHaveBeenCalledWith("/api/app-store/status", expect.objectContaining({ method: "GET" }));
    const community = setup("sample-notes"); await community.ready(); await community.receive("gateway", { url: "/api/app-store/status", method: "GET" });
    expect(community.request).not.toHaveBeenCalled(); expect(community.reply.mock.calls.at(-1)?.[0]).toContain('"ok":false');
  });
  it.each(["https://evil.test/api/app-store/status", "/api/app-store/status?extra=1", "/api/system", "/api/app-store/../system"]) ("rejects route escape %s", async url => {
    const value = setup(); await value.ready(); await value.receive("gateway", { url, method: "GET" }); expect(value.request).not.toHaveBeenCalled();
  });
  it("bounds JSON request bodies and rejects arbitrary methods/headers", async () => {
    const value = setup(); await value.ready();
    for (const [index, input] of [{ url: "/api/app-store/drafts", method: "DELETE" }, { url: "/api/app-store/drafts", method: "POST", body: "not-json" }, { url: "/api/app-store/drafts", method: "POST", headers: { Authorization: "stolen" }, body: "{}" }].entries()) await value.receive("gateway", input, index + 1);
    expect(value.request).not.toHaveBeenCalled();
  });
  it("preserves only bounded store error codes on rejected HTTP responses", async () => {
    const value = setup(); await value.ready();
    value.request.mockResolvedValueOnce(new Response(JSON.stringify({ error: "conflict" }), { status: 409 }));
    await value.receive("gateway", { url: "/api/app-store/status", method: "GET" });
    expect(value.reply.mock.calls.at(-1)?.[0]).toContain('"body":{"error":"conflict"}');
    value.request.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Postgres /private/token" }), { status: 500 }));
    await value.receive("gateway", { url: "/api/app-store/status", method: "GET" }, 2);
    expect(value.reply.mock.calls.at(-1)?.[0]).not.toContain("Postgres");
    expect(value.reply.mock.calls.at(-1)?.[0]).toContain('"ok":false');
  });
  it("opens app via native host callback without exposing credentials", async () => {
    const value = setup(); await value.ready(); await value.receive("openApp", { name: "Notes", path: "apps/sample-notes" });
    expect(value.openApp).toHaveBeenCalledWith("Notes", "apps/sample-notes", expect.any(AbortSignal)); expect(value.request).not.toHaveBeenCalled();
    const sent: unknown[] = []; const window: Record<string, any> = { ReactNativeWebView: { postMessage: (text: string) => sent.push(JSON.parse(text)) }, addEventListener: vi.fn() }; window.top = window;
    runInNewContext(buildMobileAppBridgeScript("app-gallery", "launch"), { window, setTimeout, clearTimeout, console });
    expect(typeof window.MatrixOS.gatewayFetch).toBe("function"); expect(typeof window.MatrixOS.openApp).toBe("function");
    expect(JSON.stringify(sent)).not.toContain("Authorization");
    expect(buildMobileAppBridgeScript("sample-notes", "launch")).not.toContain("gatewayFetch:function");
  });
});
