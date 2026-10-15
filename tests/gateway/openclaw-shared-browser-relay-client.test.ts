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
