import { expect, it, vi } from "vitest";
import { createOpenClawSharedBrowserRelayClient } from "../../packages/gateway/src/chat/openclaw-shared-browser-relay-client.js";
const native = { gateway: { mode: "local", bind: "loopback", port: 18789, auth: { mode: "token", token: "b".repeat(64) } } };
it("uses only the native owner's fixed authenticated loopback gateway in memory", () => {
  const client = { call: vi.fn(), close: vi.fn() }; const factory = vi.fn(() => client);
  expect(createOpenClawSharedBrowserRelayClient({ ...native, apiKey: "provider-sentinel", platformToken: "platform-sentinel" }, factory)).toBe(client);
  expect(factory).toHaveBeenCalledWith({ url: "ws://127.0.0.1:18789/", token: "b".repeat(64), maxPending: 8, timeoutMs: 10000 });
  expect(JSON.stringify(factory.mock.calls)).not.toContain("sentinel");
});
it.each([
  undefined, {}, { ...native, gateway: { ...native.gateway, mode: "remote" } },
  { ...native, gateway: { ...native.gateway, bind: "lan" } },
  { ...native, gateway: { ...native.gateway, port: 18790 } },
  { ...native, gateway: { ...native.gateway, tls: { enabled: true } } },
  { ...native, gateway: { ...native.gateway, auth: { mode: "password", password: "private" } } },
  { ...native, gateway: { ...native.gateway, auth: { mode: "token", token: { source: "env", id: "TOKEN" } } } },
  { ...native, gateway: { ...native.gateway, auth: { mode: "token", token: "short" } } },
])("fails closed for unsupported native auth/config without a credential fallback", config => {
  const create = vi.fn(); expect(() => createOpenClawSharedBrowserRelayClient(config, create)).toThrow("Native browser connection unavailable"); expect(create).not.toHaveBeenCalled();
});

it("accepts mode-only native config through an injected native SDK auth resolver", () => {
  const modeOnly = { gateway: { ...native.gateway, auth: { mode: "token" } } };
  const client = { call: vi.fn(), close: vi.fn() }; const factory = vi.fn(() => client);
  const resolve = vi.fn(() => ({ mode: "token", token: "c".repeat(64) }));
  expect(createOpenClawSharedBrowserRelayClient(modeOnly, factory, resolve)).toBe(client);
  expect(resolve).toHaveBeenCalledWith({ authConfig: modeOnly.gateway.auth, tailscaleMode: "off" });
  expect(factory).toHaveBeenCalledWith({ url: "ws://127.0.0.1:18789/", token: "c".repeat(64), maxPending: 8, timeoutMs: 10000 });
  expect(modeOnly.gateway.auth).toEqual({ mode: "token" });
});
it("delegates explicit-token precedence to the native SDK without passing platform secrets", () => {
  const resolve = vi.fn(({ authConfig }) => ({ mode: "token", token: authConfig.token }));
  const factory = vi.fn(() => ({ call: vi.fn(), close: vi.fn() }));
  createOpenClawSharedBrowserRelayClient({ ...native, apiKey: "provider-sentinel", platformToken: "platform-sentinel" }, factory, resolve);
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ authConfig: native.gateway.auth, tailscaleMode: "off" });
  expect(JSON.stringify(resolve.mock.calls)).not.toContain("sentinel");
  expect(factory.mock.calls[0]![0].token).toBe("b".repeat(64));
});
it.each([
  { mode: "token" }, { mode: "password", token: "b".repeat(64) },
  { mode: "token", token: "short" }, { mode: "token", token: "b".repeat(64), password: "private" },
])("rejects unsupported native resolver output without opening a connection", resolved => {
  const resolve = vi.fn(() => resolved); const factory = vi.fn();
  expect(() => createOpenClawSharedBrowserRelayClient(native, factory, resolve)).toThrow("Native browser connection unavailable");
  expect(factory).not.toHaveBeenCalled();
});
it("does not call the native resolver for unsupported raw gateway configuration", () => {
  const resolve = vi.fn(); const factory = vi.fn();
  for (const auth of [{ mode: "password" }, { mode: "token", token: { source: "env", id: "TOKEN" } }]) {
    expect(() => createOpenClawSharedBrowserRelayClient({ gateway: { ...native.gateway, auth } }, factory, resolve)).toThrow("Native browser connection unavailable");
  }
  expect(() => createOpenClawSharedBrowserRelayClient({ gateway: { ...native.gateway, bind: "lan" } }, factory, resolve)).toThrow();
  expect(resolve).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
});
it("redacts a failing native resolver's exception", () => {
  const resolve = vi.fn(() => { throw new Error("native-token-sentinel"); });
  expect(() => createOpenClawSharedBrowserRelayClient(native, vi.fn(), resolve)).toThrow(/^Native browser connection unavailable$/);
});
it.each([new Error("native-token-sentinel"), { name: "private-sentinel" }])("logs only a fixed safe category when native resolution throws", error => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => createOpenClawSharedBrowserRelayClient(native, vi.fn(), () => { throw error; })).toThrow("Native browser connection unavailable");
    expect(warn).toHaveBeenCalledWith("[shared-browser] Native resolver unavailable", error instanceof Error ? "error" : "non_error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sentinel");
  } finally { warn.mockRestore(); }
});

it("does not resolve a mode-only profile from unrelated config credentials without the native SDK", () => {
  const factory = vi.fn();
  expect(() => createOpenClawSharedBrowserRelayClient({ gateway: { ...native.gateway, auth: { mode: "token" } }, apiKey: "a".repeat(64), platformToken: "b".repeat(64) }, factory)).toThrow("Native browser connection unavailable");
  expect(factory).not.toHaveBeenCalled();
});
