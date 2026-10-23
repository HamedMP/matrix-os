import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisor } from "../../scripts/spikes/browser-vps/supervisor.mjs";
import { deriveAppSessionKey, signAppSession } from "../../packages/gateway/src/app-runtime/app-session.js";
import { registerBrowserLabRoutes } from "../../packages/gateway/src/browser-lab/routes.js";
import { createSharedBrowserRuntime } from "../../packages/gateway/src/shared-browser/runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function setup(gate = vi.fn(async (_enabled: boolean) => {})) {
  const supervisor = createSupervisor({ spawn: vi.fn(), terminate: vi.fn(), setHumanControl: gate });
  const nativeStatus = () => ({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: supervisor.status().humanControlAvailable });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/automation-input") return Response.json(await supervisor.automationInput(JSON.parse(String(init?.body)).enabled));
    if (path === "/browser-status") return Response.json(nativeStatus());
    if (path === "/browser-session") return Response.json(await supervisor.control({ action: "takeover" }, async () => nativeStatus()));
    if (path === "/browser-observe") return Response.json(await supervisor.observe(async () => nativeStatus()));
    if (path === "/control") return Response.json(await supervisor.control(JSON.parse(String(init?.body))));
    throw new Error("Unexpected fixture route");
  });
  const driver = { execute: vi.fn(async () => ({ success: true, observationId: "obs", content: "Synthetic invoice index" })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
  const runtime = createSharedBrowserRuntime({ homePath: "/tmp/fixture", enabled: true, ownerId: "owner", clerkOwnerId: "owner", driver, fetcher })!;
  const key = deriveAppSessionKey("shared-browser-owner-admission-secret32", "browser-lab");
  const cookie = `matrix_app_session__browser-lab=${signAppSession(key, { v: 1, slug: "browser-lab", principal: "gateway-owner", scope: "personal", iat: 1, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const app = new Hono();
  const lab = registerBrowserLabRoutes(app, { enabled: true, deriveKey: () => key, isAllowedOrigin: origin => origin === "https://app.matrix-os.com", fetcher, sharedBrowser: { broker: runtime.broker, ownerId: "owner" } });
  const binding = { ownerId: "owner", chatId: "chat-1", runId: "run-1", harness: "pi" as const };
  const controller = new AbortController(); const grant = runtime.broker.openRun(binding, controller.signal);
  const session = () => app.request("/apps/browser-lab/api/browser-session", { method: "POST", headers: { cookie, origin: "https://app.matrix-os.com", "content-type": "application/json" }, body: '{"surface":"browser"}' });
  const status = () => app.request("/apps/browser-lab/api/browser-status", { headers: { cookie } });
  const owner = (action: string) => app.request("/apps/browser-lab/api/browser-automation", { method: "POST", headers: { cookie, origin: "https://app.matrix-os.com", "content-type": "application/json" }, body: JSON.stringify({ action }) });
  const agent = () => app.request("/apps/browser-lab/api/agent-action", { method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" }, body: '{"action":"snapshot"}' });
  cleanups.push(async () => { lab.close(); await runtime.close(); await supervisor.close(); });
  return { supervisor, runtime, driver, gate, fetcher, app, cookie, session, status, agent, owner };
}

describe("shared Chrome initial owner admission", () => {
  it("cannot bypass an in-flight Chat action through the legacy diagnostic control route",async()=>{
    const s=setup();const entered=deferred<void>(),release=deferred<void>();
    s.driver.execute.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return {success:true,observationId:"obs",content:"Synthetic invoice index"};});
    const pending=s.agent();await entered.promise;
    try{
      const response=await s.app.request("/apps/browser-lab/api/control",{method:"POST",headers:{cookie:s.cookie,"content-type":"application/json"},body:'{"action":"takeover"}'});
      expect(response.status).toBe(409);expect(s.supervisor.status().humanControlAvailable).toBe(false);
      expect(s.runtime.broker.status().phase).toBe("agent");expect(s.driver.detach).not.toHaveBeenCalled();
    }finally{release.resolve();await pending;}
  });
  it("enables real supervisor input for the first idle Browser without claiming an agent", async () => {
    const s = setup(); expect(s.supervisor.status().humanControlAvailable).toBe(false);
    const response = await s.session(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ticket: expect.any(String) });
    expect(await (await s.status()).json()).toMatchObject({ humanControlAvailable: true, automation: { phase: "idle", run: null } });
    expect(s.gate).toHaveBeenLastCalledWith(true); expect(s.driver.execute).not.toHaveBeenCalled();
    expect(s.fetcher.mock.calls.some(call => String(call[0]).endsWith("/browser-session"))).toBe(true);
  });
  it("cannot admit an initial agent claim while an idle owner gate is awaiting acknowledgement", async () => {
    const release = deferred<void>();
    const s = setup(vi.fn(async enabled => { if (enabled) await release.promise; }));
    const opening = s.session();
    try {
      await vi.waitFor(() => expect(s.gate).toHaveBeenCalledWith(true));
      const refused = await s.agent(); expect(refused.status).toBe(200); expect(await refused.json()).toMatchObject({ success: false });
      expect(s.driver.execute).not.toHaveBeenCalled(); expect(s.supervisor.status().humanControlAvailable).toBe(false);
      release.resolve(); expect((await opening).status).toBe(200);
      expect(s.supervisor.status().humanControlAvailable).toBe(true);
      expect((await s.agent()).status).toBe(200); expect(s.driver.execute).toHaveBeenCalledOnce();
      expect(s.supervisor.status().humanControlAvailable).toBe(false);
    } finally { release.resolve(); }
  });
  it("returns recoverable busy admission without issuing a viewer or taking over an agent", async () => {
    const release = deferred<void>();
    const s = setup(vi.fn(async enabled => { if (enabled) await release.promise; }));
    const opening = s.session();
    try {
      await vi.waitFor(() => expect(s.gate).toHaveBeenCalledWith(true));
      const busy = await s.session(); expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: "Browser control changed. Reconnect to continue." });
      expect(s.driver.execute).not.toHaveBeenCalled();
      expect(s.gate.mock.calls.filter(call => call[0] === true)).toHaveLength(1);
      release.resolve(); expect((await opening).status).toBe(409);
      expect((await s.session()).status).toBe(200);
    } finally { release.resolve(); }
  });
  it("keeps an active agent read-only when a Browser viewer is admitted", async () => {
    const s = setup(); await s.agent(); const count = s.gate.mock.calls.length;
    expect((await s.session()).status).toBe(200);
    expect(s.gate).toHaveBeenCalledTimes(count); expect(s.supervisor.status().humanControlAvailable).toBe(false);
    expect(s.runtime.broker.status().phase).toBe("agent");
    expect(s.fetcher.mock.calls.some(call => String(call[0]).endsWith("/browser-session"))).toBe(false);
  });
  it("keeps failed idle admission read-only and permits explicit owner recovery", async () => {
    let fail = true;
    const s = setup(vi.fn(async enabled => { if (enabled && fail) { fail = false; throw new Error("private native gate failure"); } }));
    const response = await s.session(); expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Browser service unavailable" });
    expect(s.supervisor.status().humanControlAvailable).toBe(false); expect(s.driver.execute).not.toHaveBeenCalled();
    expect(await (await s.owner("takeover")).json()).toMatchObject({ humanControlAvailable: true, automation: { phase: "idle", run: null } });
    expect((await s.session()).status).toBe(200);
  });
});
