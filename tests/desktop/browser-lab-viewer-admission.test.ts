import { describe, expect, it, vi } from "vitest";
import { createBrowserLabViewerAdmission } from "@desktop/main/embeds/browser-lab-viewer-admission";

const base = "https://app.matrix-os.com";
const ticket = "a".repeat(48);
function setup() {
  let listener: any;
  let generation = 1;
  let token: string | null = "synthetic-native-bearer";
  let origin = base;
  let topUrl = `${base}/apps/browser-lab/`;
  let destroyed = false;
  const session = { webRequest: { onBeforeSendHeaders: vi.fn((_filter, callback) => { listener = callback; }) } };
  const contents = { id: 42, session, getURL: () => topUrl, isDestroyed: () => destroyed, once: vi.fn(), removeListener: vi.fn() };
  const admission = createBrowserLabViewerAdmission({ getGatewayOrigin: () => origin, getToken: () => token, getAuthGeneration: () => generation });
  const unregister = admission.register(contents);
  const details = { url: `wss://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`, method: "GET", resourceType: "webSocket", webContentsId: 42, frame: { url: `${base}/apps/browser-lab/viewer/?resize=scale` }, requestHeaders: { Origin: base } };
  const send = (overrides = {}) => {
    const callback = vi.fn();
    listener?.({ ...details, ...overrides }, callback);
    return callback.mock.calls[0]?.[0]?.requestHeaders?.Authorization;
  };
  return { admission, contents, session, send, unregister, details,
    generation: () => generation++, token: (value: string | null) => { token = value; },
    origin: (value: string) => { origin = value; }, topUrl: (value: string) => { topUrl = value; },
    destroy: () => { destroyed = true; } };
}

describe("native Browser Lab viewer admission", () => {
  it("releases the destroyed listener when admission is refreshed or drained", () => {
    const f = setup(); f.unregister();
    expect(f.contents.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
    f.admission.register(f.contents); f.admission.close();
    expect(f.contents.removeListener).toHaveBeenCalledTimes(2);
  });
  it("authenticates only the installed Kasm iframe WS transport without exposing credentials to app code", () => {
    const f = setup();
    expect(f.send()).toBe("Bearer synthetic-native-bearer");
    f.unregister();
    expect(f.session.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(expect.any(Object), null);
  });
  it.each([
    { requestHeaders: { Origin: "https://attacker.test" } }, { requestHeaders: {} },
    { resourceType: "xhr" }, { method: "POST" }, { webContentsId: 43 }, { webContentsId: undefined },
    { frame: undefined }, { frame: { url: `${base}/apps/browser-lab/` } },
    { frame: { url: "https://attacker.test/apps/browser-lab/viewer/" } },
    { url: `https://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}` },
    { url: `wss://attacker.test/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}` },
    { url: `wss://app.matrix-os.com:8443/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}` },
    { url: `wss://app.matrix-os.com/api/chats?lab_ticket=${ticket}` },
    { url: `wss://app.matrix-os.com/apps/notes/viewer/websockify?lab_ticket=${ticket}` },
    { url: "wss://app.matrix-os.com/apps/browser-lab/viewer/websockify" },
    { url: "wss://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=bad" },
    { url: `wss://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}&lab_ticket=${ticket}` },
    { url: `wss://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}&token=other` },
    { url: `wss://user@app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}` },
    { url: `wss://app.matrix-os.com/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}#fragment` },
  ])("does not attach native authentication outside precise admission: %j", overrides => {
    const f = setup(); expect(f.send(overrides)).toBeUndefined(); f.unregister();
  });
  it("replaces case-insensitive authorization without duplicate headers and preserves the browser origin", () => {
    const f = setup();
    const listener = f.session.webRequest.onBeforeSendHeaders.mock.calls[0]![1] as any;
    const callback = vi.fn();
    listener({ ...f.details, requestHeaders: { Origin: base, authorization: "Bearer other", AUTHORIZATION: "Bearer duplicate" } }, callback);
    expect(callback.mock.calls[0]![0].requestHeaders).toEqual({ Origin: base, Authorization: "Bearer synthetic-native-bearer" });
    f.unregister();
  });
  it.each(["generation", "no-token", "origin", "navigation", "destroyed", "unregister"])("revokes admission after %s", reason => {
    const f = setup();
    const staleListener = f.session.webRequest.onBeforeSendHeaders.mock.calls[0]![1] as any;
    if (reason === "generation") f.generation();
    if (reason === "no-token") f.token(null);
    if (reason === "origin") f.origin("https://other.test");
    if (reason === "navigation") f.topUrl(`${base}/apps/notes/`);
    if (reason === "destroyed") f.destroy();
    if (reason === "unregister") f.unregister();
    const callback = vi.fn(); staleListener(f.details, callback);
    expect(callback.mock.calls[0]![0].requestHeaders.Authorization).toBeUndefined();
    f.unregister();
  });
  it("keeps concurrent lab views bound individually and removes the hook after the last closes", () => {
    const f = setup();
    const second = { ...f.contents, id: 43 };
    const unregisterSecond = f.admission.register(second);
    expect(f.send({ webContentsId: 43 })).toBe("Bearer synthetic-native-bearer");
    f.unregister();
    expect(f.send()).toBeUndefined();
    expect(f.send({ webContentsId: 43 })).toBe("Bearer synthetic-native-bearer");
    unregisterSecond();
    expect(f.session.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(expect.any(Object), null);
  });
  it("drains transport registration on runtime shutdown before reopening against the new principal", () => {
    const f = setup();
    const oldListener = f.session.webRequest.onBeforeSendHeaders.mock.calls[0]![1] as any;
    f.admission.close();
    f.generation();
    const callback = vi.fn(); oldListener(f.details, callback);
    expect(callback.mock.calls[0]![0].requestHeaders.Authorization).toBeUndefined();
    const unregister = f.admission.register(f.contents);
    expect(f.send()).toBe("Bearer synthetic-native-bearer");
    unregister();
  });
  it("fails closed when the configured origin becomes invalid", () => {
    const f = setup(); f.origin("invalid gateway");
    expect(f.send()).toBeUndefined(); f.unregister();
  });
});
