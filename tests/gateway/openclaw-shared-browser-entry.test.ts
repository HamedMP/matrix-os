import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin, { OPENCLAW_SHARED_BROWSER_MANIFEST, createOpenClawSharedBrowserPlugin } from "../../packages/gateway/src/chat/openclaw-shared-browser-plugin-entry.js";
const originalBrowserLabFlag = process.env.MATRIX_BROWSER_LAB;
beforeEach(() => { process.env.MATRIX_BROWSER_LAB = "true"; });
afterEach(() => {
  if (originalBrowserLabFlag === undefined) delete process.env.MATRIX_BROWSER_LAB;
  else process.env.MATRIX_BROWSER_LAB = originalBrowserLabFlag;
});
function nativeApi() {
  const services: Array<{ stop(): Promise<void> }> = [];
  return { services, config: { gateway: { bind: "loopback", mode: "local", port: 18789, auth: { mode: "token", token: "b".repeat(64) } } }, registerService: (service: { stop(): Promise<void> }) => services.push(service), lifecycle: { registerRuntimeLifecycle: vi.fn() } };
}
it("declares exact pinned native tool ownership and startup activation for protected bind RPC", async () => {
  expect(OPENCLAW_SHARED_BROWSER_MANIFEST).toMatchObject({ id: "matrix-shared-browser", activation: { onStartup: true }, contracts: { tools: ["shared_browser"] } });
  const hooks = new Map<string, () => void>();
  const api = { ...nativeApi(), pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: () => void) => hooks.set(name, handler) };
  plugin.register(api as never);
  expect(api.registerGatewayMethod.mock.calls.map(call => call[0])).toEqual(["matrix.browser.bind", "matrix.browser.revoke", "matrix.browser.before", "matrix.browser.execute", "matrix.browser.cancel", "matrix.browser.end"]);
  expect(api.registerGatewayMethod.mock.calls.every(call => call[2].scope === "operator.admin")).toBe(true);
  await hooks.get("gateway_stop")!();
  await api.services[0]!.stop();
  expect(() => plugin.register({ ...api, pluginConfig: { gatewayPort: 70000 } } as never)).toThrow();
});
it("enables safe diagnostics only for the exact opt-in environment value", async () => {
  const original = process.env.MATRIX_BROWSER_DIAGNOSTICS;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.MATRIX_BROWSER_DIAGNOSTICS;
      else process.env.MATRIX_BROWSER_DIAGNOSTICS = value;
      const hooks = new Map<string, (event?: unknown, context?: unknown) => void>();
      const api = { ...nativeApi(), pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: never) => hooks.set(name, handler) };
      plugin.register(api as never);
      await hooks.get("gateway_stop")!();
    await api.services[0]!.stop();
    }
    expect(warn).not.toHaveBeenCalledWith("[shared-browser-openclaw] lifecycle", expect.anything());
    process.env.MATRIX_BROWSER_DIAGNOSTICS = "1";
    const hooks = new Map<string, (event?: unknown, context?: unknown) => void>();
    const api = { ...nativeApi(), pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: never) => hooks.set(name, handler) };
    plugin.register(api as never);
    await hooks.get("gateway_stop")!();
    await api.services[0]!.stop();
    expect(warn).toHaveBeenCalledWith("[shared-browser-openclaw] lifecycle", expect.stringMatching(/^\{"event":"gateway_stop","generation":"[a-f0-9]{16}",/));
  } finally {
    if (original === undefined) delete process.env.MATRIX_BROWSER_DIAGNOSTICS;
    else process.env.MATRIX_BROWSER_DIAGNOSTICS = original;
    warn.mockRestore();
  }
});

it("injects the native SDK resolver before registering mode-only owner gateway auth", async () => {
  const resolveNativeAuth = vi.fn(() => ({ mode: "token", token: "c".repeat(64) }));
  const hooks = new Map<string, () => void>();
  const base = nativeApi(); const modeOnly = { ...base.config, gateway: { ...base.config.gateway, auth: { mode: "token" } } };
  const api = { ...base, config: modeOnly, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: () => void) => hooks.set(name, handler) };
  createOpenClawSharedBrowserPlugin(resolveNativeAuth).register(api as never);
  expect(resolveNativeAuth).toHaveBeenCalledExactlyOnceWith({ authConfig: { mode: "token" }, tailscaleMode: "off" });
  expect(api.registerGatewayMethod).toHaveBeenCalledTimes(6);
  expect(modeOnly.gateway.auth).toEqual({ mode: "token" });
  await hooks.get("gateway_stop")!(); await api.services[0]!.stop();
});

it.each([undefined, "false", "1", "TRUE"])("does not resolve auth or register any authority without the trusted optional flag (%s)", value => {
  if (value === undefined) delete process.env.MATRIX_BROWSER_LAB;
  else process.env.MATRIX_BROWSER_LAB = value;
  const resolver = vi.fn(); const api = { config: {}, pluginConfig: {}, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), registerService: vi.fn(), on: vi.fn() };
  expect(() => createOpenClawSharedBrowserPlugin(resolver).register(api as never)).not.toThrow();
  expect(() => plugin.register(api as never)).not.toThrow();
  expect(resolver).not.toHaveBeenCalled(); expect(api.registerGatewayMethod).not.toHaveBeenCalled();
  expect(api.registerTool).not.toHaveBeenCalled(); expect(api.registerService).not.toHaveBeenCalled(); expect(api.on).not.toHaveBeenCalled();
});
