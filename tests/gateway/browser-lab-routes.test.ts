import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { deriveAppSessionKey, signAppSession } from "../../packages/gateway/src/app-runtime/app-session.js";
import { registerBrowserLabRoutes } from "../../packages/gateway/src/browser-lab/routes.js";

const master = "browser-lab-test-master-secret-32";
function cookie(exp = Math.floor(Date.now() / 1000) + 600, slug = "browser-lab") {
  return `matrix_app_session__browser-lab=${signAppSession(deriveAppSessionKey(master, "browser-lab"), {
    v: 1, slug, principal: "gateway-owner", scope: "personal", iat: 1, exp,
  })}`;
}
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((close) => close()); vi.restoreAllMocks(); });
function setup(enabled = true, response = new Response("ok"), sharedBrowser?: { broker: never; ownerId: string }) {
  const app = new Hono();
  const fetcher = vi.fn(async () => response);
  const upgradeWebSocket = vi.fn(() => async (c: any) => c.text("upgraded"));
  cleanup.push(registerBrowserLabRoutes(app, {
    enabled, deriveKey: () => deriveAppSessionKey(master, "browser-lab"),
    isAllowedOrigin: (origin) => origin === "https://app.matrix-os.com", fetcher,
    upgradeWebSocket, viewerAuthorization: "Basic c3ludGhldGljOm9ubHk=", sharedBrowser,
  }).close);
  return { app, fetcher, upgradeWebSocket };
}

describe("browser lab owner session proxy", () => {
  it("advertises when the comparison controller is disabled by shared Chat", async () => {
    const payload = { phase: "idle", engine: null, generation: 0, checkpoint: 0, workCompleted: 0, humanControlAvailable: true };
    const plain = setup(true, Response.json(payload));
    const plainStatus = await plain.app.request("/apps/browser-lab/api/status", { headers: { cookie: cookie() } });
    expect(plainStatus.headers.get("x-matrix-browser-lab-comparison")).toBe("enabled");
    const shared = setup(true, Response.json(payload), { broker: {} as never, ownerId: "owner" });
    const sharedStatus = await shared.app.request("/apps/browser-lab/api/status", { headers: { cookie: cookie() } });
    expect(sharedStatus.headers.get("x-matrix-browser-lab-comparison")).toBe("disabled");
  });
  it('adds exact coarse product status and strict product control routes', async () => {
    const state = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
    const { app, fetcher } = setup(true, Response.json(state));
    expect((await app.request('/apps/browser-lab/api/browser-status', { headers: { cookie: cookie() } })).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8730/browser-status');
    expect((await app.request('/apps/browser-lab/api/browser-control', { method: 'POST', headers: { cookie: cookie(), origin: 'https://attacker.test' }, body: '{"action":"restore-chrome"}' })).status).toBe(403);
    expect((await app.request('/apps/browser-lab/api/browser-control', { method: 'POST', headers: { cookie: cookie() }, body: '{"action":"restore-chrome","title":"private"}' })).status).toBe(400);
  });
  it('product activation revokes pending diagnostic tickets and denies diagnostic bypass', async () => {
    const { app } = setup(true, Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true }));
    const { ticket: oldTicket } = await (await app.request('/apps/browser-lab/api/viewer-session', { headers: { cookie: cookie() } })).json();
    const claim = await app.request('/apps/browser-lab/api/browser-session', { method: 'POST', headers: { cookie: cookie(), origin: 'https://app.matrix-os.com' }, body: '{"surface":"browser"}' });
    expect(claim.status).toBe(200);
    const { ticket } = await claim.json(); expect(ticket).toMatch(/^[a-f0-9]{48}$/);
    expect((await app.request(`/apps/browser-lab/viewer/websockify?lab_ticket=${oldTicket}`)).status).toBe(401);
    expect((await app.request('/apps/browser-lab/api/viewer-session', { headers: { cookie: cookie() } })).status).toBe(409);
    expect((await app.request(`/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`)).status).toBe(426);
  });
  it("is unavailable when disabled", async () => {
    const { app, fetcher } = setup(false);
    expect((await app.request("/apps/browser-lab/api/status", { headers: { cookie: cookie() } })).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, cookie(1), cookie(undefined, "other-app")])("rejects absent, expired or mismatched signed session", async (value) => {
    const { app, fetcher } = setup();
    const response = await app.request("/apps/browser-lab/api/status", { headers: value ? { cookie: value } : {} });
    expect(response.status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  });
  it("mints narrowly scoped one-use viewer tickets without exposing app authentication", async () => {
    const { app } = setup();
    const response = await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: cookie() } });
    expect(response.status).toBe(200);
    const { ticket, expiresAt } = await response.json();
    expect(ticket).toMatch(/^[a-f0-9]{48}$/);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect((await app.request(`/apps/browser-lab/api/status?lab_ticket=${ticket}`)).status).toBe(401);
    const websocket = `/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`;
    expect((await app.request(websocket)).status).toBe(426);
    expect((await app.request(websocket)).status).toBe(401);
  });
  it("rejects expired viewer tickets and caps minted tickets", async () => {
    const { app } = setup();
    const before = Date.now();
    const { ticket } = await (await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: cookie() } })).json();
    const now = vi.spyOn(Date, "now").mockReturnValue(before + 61_000);
    expect((await app.request(`/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`)).status).toBe(401);
    now.mockRestore();
    for (let i = 0; i < 8; i++) {
      expect((await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: cookie() } })).status).toBe(200);
    }
    expect((await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: cookie() } })).status).toBe(503);
  });
  it("proxies assets to fixed Kasm address without credentials or forwarded host", async () => {
    const { app, fetcher } = setup();
    const response = await app.request("/apps/browser-lab/viewer/app/ui.js?_=123", {
      headers: { cookie: cookie(), authorization: "Bearer private-token", "x-forwarded-host": "attacker.test" },
    });
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:6901/app/ui.js?_=123");
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe("error"); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).has("cookie")).toBe(false);
    expect(new Headers(options.headers).get("authorization")).toBe("Basic c3ludGhldGljOm9ubHk=");
    expect(await response.text()).not.toContain("c3ludGhldGlj");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("restricts controls and enforces body limit before parsing", async () => {
    const { app, fetcher } = setup();
    for (const body of ['{"action":"shell","cmd":"id"}', '{"action":"takeover","extra":1}', '"' + 'x'.repeat(5000) + '"']) {
      const response = await app.request("/apps/browser-lab/api/control", { method: "POST", headers: { cookie: cookie(), "content-type": "application/json" }, body });
      expect([400, 413]).toContain(response.status);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forwards only validated control fields", async () => {
    const { app, fetcher } = setup(true, Response.json({ state: "paused" }));
    const response = await app.request("/apps/browser-lab/api/control", { method: "POST", headers: { cookie: cookie(), origin: "https://app.matrix-os.com" }, body: '{"action":"takeover"}' });
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:8730/control");
    expect((fetcher.mock.calls[0][1] as RequestInit).body).toBe('{"action":"takeover"}');
    expect(new Headers((fetcher.mock.calls[0][1] as RequestInit).headers).has('authorization')).toBe(false);
  });
  it("rejects cross-origin controls and viewer upgrades", async () => {
    const { app, fetcher, upgradeWebSocket } = setup();
    expect((await app.request("/apps/browser-lab/api/control", { method: "POST", headers: { cookie: cookie(), origin: "https://attacker.test" }, body: '{"action":"stop"}' })).status).toBe(403);
    const { ticket } = await (await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: cookie() } })).json();
    expect((await app.request(`/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`, { headers: { origin: "https://attacker.test", upgrade: "websocket" } })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled(); expect(upgradeWebSocket).not.toHaveBeenCalled();
  });
  it("limits upstream bodies and normalizes upstream failures", async () => {
    const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(17 * 1024 * 1024)); c.close(); } });
    const { app } = setup(true, new Response(oversized));
    const response = await app.request("/apps/browser-lab/viewer/", { headers: { cookie: cookie() } });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("127.0.0.1");
    const failed = setup(true, new Response("provider secret error", { status: 500 }));
    expect(await (await failed.app.request("/apps/browser-lab/api/status", { headers: { cookie: cookie() } })).text()).not.toContain("secret");
  });
  it("rejects unknown API paths and methods instead of passing them upstream", async () => {
    const { app, fetcher } = setup();
    expect((await app.request("/apps/browser-lab/api/other", { headers: { cookie: cookie() } })).status).toBe(404);
    expect((await app.request("/apps/browser-lab/viewer/", { method: "POST", headers: { cookie: cookie() } })).status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
