import { expect, it, vi } from "vitest";
import plugin, { OPENCLAW_SHARED_BROWSER_MANIFEST } from "../../packages/gateway/src/chat/openclaw-shared-browser-plugin-entry.js";
it("declares exact pinned native tool ownership and startup activation for protected bind RPC", () => {
  expect(OPENCLAW_SHARED_BROWSER_MANIFEST).toMatchObject({ id: "matrix-shared-browser", activation: { onStartup: true }, contracts: { tools: ["shared_browser"] } });
  const hooks = new Map<string, () => void>();
  const api = { pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: () => void) => hooks.set(name, handler) };
  plugin.register(api as never);
  expect(api.registerGatewayMethod.mock.calls.map(call => call[0])).toEqual(["matrix.browser.bind", "matrix.browser.revoke"]);
  expect(api.registerGatewayMethod.mock.calls.every(call => call[2].scope === "operator.admin")).toBe(true);
  hooks.get("gateway_stop")!();
  expect(() => plugin.register({ ...api, pluginConfig: { gatewayPort: 70000 } } as never)).toThrow();
});
it("enables safe diagnostics only for the exact opt-in environment value", () => {
  const original = process.env.MATRIX_BROWSER_DIAGNOSTICS;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.MATRIX_BROWSER_DIAGNOSTICS;
      else process.env.MATRIX_BROWSER_DIAGNOSTICS = value;
      const hooks = new Map<string, (event?: unknown, context?: unknown) => void>();
      plugin.register({ pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: never) => hooks.set(name, handler) } as never);
      hooks.get("gateway_stop")!();
    }
    expect(warn).not.toHaveBeenCalledWith("[shared-browser-openclaw] lifecycle", expect.anything());
    process.env.MATRIX_BROWSER_DIAGNOSTICS = "1";
    const hooks = new Map<string, (event?: unknown, context?: unknown) => void>();
    plugin.register({ pluginConfig: { gatewayPort: 4000 }, registerGatewayMethod: vi.fn(), registerTool: vi.fn(), on: (name: string, handler: never) => hooks.set(name, handler) } as never);
    hooks.get("gateway_stop")!();
    expect(warn).toHaveBeenCalledWith("[shared-browser-openclaw] lifecycle", expect.stringMatching(/^\{"event":"gateway_stop","generation":"[a-f0-9]{16}",/));
  } finally {
    if (original === undefined) delete process.env.MATRIX_BROWSER_DIAGNOSTICS;
    else process.env.MATRIX_BROWSER_DIAGNOSTICS = original;
    warn.mockRestore();
  }
});
