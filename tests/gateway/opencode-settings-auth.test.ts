import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openOpenCodeAuthSession, createOpenCodeSettingsConnection, enableOpenCodeConnectedRoute } from "../../packages/gateway/src/ai-providers/opencode-settings-auth.js";
import type { OpenCodeSpawnFn, OpenCodeProcess } from "../../packages/gateway/src/coding-agents/opencode-provider.js";

function native() {
  const child = new EventEmitter() as EventEmitter & OpenCodeProcess & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); return true; });
  const spawn = vi.fn<OpenCodeSpawnFn>(() => { queueMicrotask(() => child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:43001\n"))); return child; });
  return { child, spawn };
}
const methods = { openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "oauth", label: "ChatGPT Pro/Plus (headless)" }, { type: "api", label: "Manually enter API Key" }] };
function mockSession(changes: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { "/global/health": { healthy: true, version: "1.18.34" }, "/provider/auth": methods,
    "/provider/openai/oauth/authorize": { url: "https://auth.openai.com/codex/device", method: "auto", instructions: "Enter code: TEST-CODE" },
    "/provider/openai/oauth/callback": true, "/provider": { connected: ["openai"] }, "/auth/openai": true, ...changes };
  return { request: vi.fn(async (path: string) => values[path]), close: vi.fn().mockResolvedValue(undefined) };
}
const request = { kind: "login" as const, method: "device_code" as const, harnessInstanceId: "opencode", idempotencyKey: "test-connect-key" };
describe("OpenCode Settings native auth transport", () => {
  it("starts only protected loopback with an ephemeral port and scoped owner environment", async () => {
    const n = native(); const fetch = vi.fn().mockResolvedValue(Response.json({ healthy: true, version: "1.18.34" }));
    const session = await openOpenCodeAuthSession({ command: "/opt/matrix/runtime/node/bin/opencode", cwd: "/owner", env: { HOME: "/owner" }, spawn: n.spawn, fetch });
    expect(n.spawn).toHaveBeenCalledWith("/opt/matrix/runtime/node/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], expect.objectContaining({ env: expect.objectContaining({ HOME: "/owner", OPENCODE_SERVER_PASSWORD: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    await session.request("/global/health");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43001/global/health", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ authorization: expect.stringMatching(/^Basic /) }) }));
    await expect(session.request("/auth/anthropic")).rejects.toThrow("unavailable");
    await session.close(); expect(n.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("bounds response bytes and rejects redirect/error before returning native output", async () => {
    const n = native(); const fetch = vi.fn().mockResolvedValue(new Response("a".repeat(256 * 1024 + 1)));
    const session = await openOpenCodeAuthSession({ command: "/bin/opencode", cwd: "/owner", env: {}, spawn: n.spawn, fetch });
    await expect(session.request("/provider/auth")).rejects.toThrow("unavailable"); await session.close();
  });
  it("discovers the exact installed CLI headless method before advertising capabilities and closes the probe", async () => {
    const session = mockSession(); const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected: vi.fn() });
    expect(await connection.capabilities()).toEqual({ login: true, apiKey: true }); expect(session.close).toHaveBeenCalledOnce();
  });
  it("does not advertise browser localhost callbacks or methods needing unimplemented prompt input", async () => {
    const session = mockSession({ "/provider/auth": { openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "oauth", label: "ChatGPT Pro/Plus (headless)", prompts: [{ type: "text" }] }] } });
    const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected: vi.fn() });
    expect(await connection.capabilities()).toEqual({ login: false, apiKey: false });
  });
  it("publishes only device URL/code and enables only after native callback and canonical route confirmation", async () => {
    const session = mockSession(); const enableConnected = vi.fn(); const publish = vi.fn();
    const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected });
    await connection.start({ registerCleanup: () => {},  request, publish });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }));
    expect(publish).toHaveBeenCalledWith({ authorizationUrl: "https://auth.openai.com/codex/device", deviceCode: "TEST-CODE" });
    expect(session.request).toHaveBeenCalledWith("/provider/openai/oauth/authorize", "POST", { method: 1 });
    expect(enableConnected).toHaveBeenCalledWith("opencode", `opencode-connect-${createHash("sha256").update("test-connect-key").digest("hex")}`); expect(session.close).toHaveBeenCalled();
  });
  it.each(["https://evil.test/codex/device", "https://auth.openai.com/codex/device?key=secret", "http://127.0.0.1:1455/"])("rejects non-device authorization %s", async url => {
    const session = mockSession({ "/provider/openai/oauth/authorize": { url, method: "auto", instructions: "Enter code: TEST-CODE" } }); const publish = vi.fn();
    const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected: vi.fn() });
    await expect(connection.start({ registerCleanup: () => {},  request, publish })).rejects.toThrow("unavailable"); expect(publish).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalled();
  });
  it("does not enable when cancelled while the CLI callback is pending", async () => {
    const session = mockSession(); let finish!: (value: boolean) => void;
    session.request.mockImplementation(async path => path.endsWith("callback") ? new Promise<boolean>(resolve => { finish = resolve; }) : path.endsWith("authorize") ? { url: "https://auth.openai.com/codex/device", method: "auto", instructions: "Enter code: TEST-CODE" } : path.endsWith("health") ? { healthy: true, version: "1.18.34" } : methods);
    const enableConnected = vi.fn(); const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected });
    const active = await connection.start({ registerCleanup: () => {},  request, publish: vi.fn() }); await active.cancel(); finish(true); await new Promise(resolve => setTimeout(resolve, 0));
    expect(enableConnected).not.toHaveBeenCalled();
  });
  it("validates a key before handing it to the native PUT auth API and enabling", async () => {
    const session = mockSession(); const enableConnected = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected, fetch });
    await connection.verifyKey({ harnessInstanceId: "opencode", providerId: "openai", apiKey: "test-secret" });
    expect(session.request).toHaveBeenCalledWith("/auth/openai", "PUT", { type: "api", key: "test-secret" }); expect(enableConnected).toHaveBeenCalledOnce();
  });
  it("preserves prior native credentials on key rejection", async () => {
    const session = mockSession(); const enableConnected = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const connection = createOpenCodeSettingsConnection({ session: async () => session, enableConnected, fetch });
    await expect(connection.verifyKey({ harnessInstanceId: "opencode", providerId: "openai", apiKey: "test-secret" })).rejects.toThrow("rejected");
    expect(session.request).not.toHaveBeenCalledWith("/auth/openai", expect.anything(), expect.anything()); expect(enableConnected).not.toHaveBeenCalled();
  });
});

it("coalesces bounded capability probes rather than spawning a process per concurrent read", async () => {
  const session = mockSession(); const factory = vi.fn().mockResolvedValue(session);
  const connection = createOpenCodeSettingsConnection({ session: factory, enableConnected: vi.fn() });
  await Promise.all(Array.from({ length: 20 }, () => connection.capabilities()));
  expect(factory).toHaveBeenCalledOnce(); await connection.capabilities(); expect(factory).toHaveBeenCalledOnce();
});
it("sanitizes inherited provider keys and runtime config redirects", async () => {
  const n = native();
  const session = await openOpenCodeAuthSession({ command: "/bin/opencode", cwd: "/owner", env: { HOME: "/owner", OPENAI_API_KEY: "operator-secret", OPENCODE_CONFIG: "/operator/config", XDG_CONFIG_HOME: "/operator" }, spawn: n.spawn });
  const environment = n.spawn.mock.calls[0]![2]!.env;
  expect(environment.OPENAI_API_KEY).toBeUndefined(); expect(environment.OPENCODE_CONFIG).toBeUndefined(); expect(environment.XDG_CONFIG_HOME).toBeUndefined(); expect(environment.HOME).toBe("/owner");
  await session.close();
});
it("reaps invalid startup output rather than trusting a non-loopback readiness URL", async () => {
  vi.useFakeTimers();
  try {
    const n = native(); n.spawn.mockImplementation(() => { queueMicrotask(() => n.child.stdout.emit("data", Buffer.from("opencode server listening on http://0.0.0.0:4096\n"))); return n.child; });
    const ready = openOpenCodeAuthSession({ command: "/bin/opencode", cwd: "/owner", env: {}, spawn: n.spawn });
    const rejected = expect(ready).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(10001); await rejected;
    expect(n.child.kill).toHaveBeenCalledWith("SIGTERM");
  } finally { vi.useRealTimers(); }
});
it("enables an explicit OpenAI connection with the exact native source and retains a compatible saved model", async () => {
  const mutate = vi.fn(); const snapshot = { revision: 15, atomicConnectSupported: true, access: { mode: "writable" }, harnesses: [{ id: "oc2", harness: "opencode", route: { modelId: "openai/gpt-second" } }], accessSources: [{ id: "harness_opencode_openai", kind: "harness_profile", harness: "opencode", providerId: "openai", accountId: null, localObservation: { state: "present_unverified" }, eligibleModelIds: ["openai/gpt-first", "openai/gpt-second"] }], modelProviders: [{ id: "openai", models: [{ id: "openai/gpt-first", enabled: true }, { id: "openai/gpt-second", enabled: true }] }] };
  await enableOpenCodeConnectedRoute({ getSnapshot: vi.fn().mockResolvedValue(snapshot), mutate } as never, "oc2", "connect-exact");
  expect(mutate).toHaveBeenCalledWith({ type: "set_route", harnessInstanceId: "oc2", route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-second" }, accessSourceId: "harness_opencode_openai", accountId: null, enableHarness: true, expectedRevision: 15, idempotencyKey: "connect-exact" });
});
it("fails closed without a supported exact native source/model and preserves owner configuration", async () => {
  const mutate = vi.fn();
  await expect(enableOpenCodeConnectedRoute({ getSnapshot: vi.fn().mockResolvedValue({ harnesses: [], accessSources: [], modelProviders: [] }), mutate } as never, "missing", "connect-missing")).rejects.toThrow("unavailable"); expect(mutate).not.toHaveBeenCalled();
});
it("wires discovered OpenCode methods to the direct Settings adapter without creating Terminal tabs", async () => {
  const { createNativeProviderWorkflowAdapters } = await import("../../packages/gateway/src/ai-providers/provider-workflow-native.js");
  const connection = { close: vi.fn(async () => {}), capabilities: vi.fn().mockResolvedValue({ login: true, apiKey: true }), start: vi.fn().mockResolvedValue({ cancel: vi.fn() }), verifyKey: vi.fn() };
  const terminal = { createTab: vi.fn() };
  const store = { getSnapshot: vi.fn().mockResolvedValue({ access: { mode: "writable" }, harnesses: [{ id: "opencode", harness: "opencode", displayName: "OpenCode", installState: "installed", loginMethods: ["terminal"] }] }) };
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: store as never, terminal: terminal as never, hostControl: { available: false, run: vi.fn() }, opencodeConnection: connection });
  expect(adapter!.loginMethods).toEqual(["device_code"]); expect(adapter!.apiKeyProviders).toEqual(["openai"]);
  const publish = vi.fn(); await adapter!.start({ registerCleanup: () => {},  request, publish }); expect(connection.start).toHaveBeenCalledWith({ request, publish, registerCleanup: expect.any(Function) }); expect(terminal.createTab).not.toHaveBeenCalled();
});
it("keeps unsupported OpenCode protocol capabilities closed without guessing a Terminal auth fallback", async () => {
  const { createNativeProviderWorkflowAdapters } = await import("../../packages/gateway/src/ai-providers/provider-workflow-native.js");
  const connection = { close: vi.fn(async () => {}), capabilities: vi.fn().mockRejectedValue(new Error("protocol mismatch")), start: vi.fn(), verifyKey: vi.fn() };
  const store = { getSnapshot: vi.fn().mockResolvedValue({ access: { mode: "writable" }, harnesses: [{ id: "opencode", harness: "opencode", displayName: "OpenCode", installState: "installed", loginMethods: ["terminal"] }] }) };
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: store as never, terminal: {} as never, hostControl: { available: false, run: vi.fn() }, opencodeConnection: connection });
  expect(adapter!.loginMethods).toEqual([]); expect(adapter!.apiKeyProviders).toEqual([]); expect(adapter!.verifyKey).toBeUndefined();
});
it('drains an already committing route writer before cancellation settles', async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const enableConnected = vi.fn(() => gate); const publish = vi.fn();
  const connection = createOpenCodeSettingsConnection({ session: async () => mockSession(), enableConnected });
  const running = await connection.start({ registerCleanup: () => {}, request, publish });
  await vi.waitFor(() => expect(enableConnected).toHaveBeenCalledOnce());
  const cancelling = running.cancel();
  expect(await Promise.race([cancelling.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 20))])).toBe(false);
  finish(); await cancelling;
  expect(publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }); await connection.close();
});
