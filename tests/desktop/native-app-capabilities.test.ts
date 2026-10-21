import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_CAPABILITY_CHANNEL, APP_AI_ROUTES_CHANNEL } from "@matrix-os/contracts";
import { NativeAppBridge } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppCapabilityRequester, createNativeAppAiRoutesRequester } from "@desktop/main/embeds/native-app-capabilities";

function fixture() {
  let generation = 0;
  let origin = "https://gateway.test";
  const capabilityRequest = vi.fn(async () => ({ version: 1, integrations: true, ai: true }));
  const aiRoutesRequest = vi.fn(async () => ({ routes: [], defaultRoute: null }));
  const bridge = new NativeAppBridge({ authGeneration: () => generation, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), capabilityRequest, aiRoutesRequest, gatewayOrigin: () => origin });
  bridge.register(1, "projects/brain", "brain");
  const frame = {};
  const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, getURL: () => "https://gateway.test/apps/brain/", isDestroyed: () => false } };
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  bridge.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  return { bridge, event, handlers, capabilityRequest, aiRoutesRequest, setGeneration: () => generation++, setOrigin: (value: string) => origin = value };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("native app capability IPC", () => {
  it("binds app identity and validates integration actions", async () => {
    const f = fixture();
    const handler = f.handlers.get(APP_CAPABILITY_CHANNEL)!;
    await handler(f.event, { kind: "integrations.call", service: "google-drive", action: "list_files", params: { limit: 10 } });
    expect(f.capabilityRequest).toHaveBeenCalledWith("projects/brain", { kind: "integrations.call", service: "google-drive", action: "list_files", params: { limit: 10 } }, expect.any(AbortSignal));
    await expect(handler(f.event, { kind: "capabilities", app: "other" })).rejects.toThrow("App integrations are unavailable");
    expect(f.capabilityRequest).toHaveBeenCalledTimes(1);
  });
  it("rejects subframes, navigation, destroyed views and stale authentication", async () => {
    const f = fixture();
    const handler = f.handlers.get(APP_CAPABILITY_CHANNEL)!;
    await expect(handler({ ...f.event, senderFrame: {} }, { kind: "capabilities" })).rejects.toThrow();
    await expect(handler({ ...f.event, sender: { ...f.event.sender, getURL: () => "https://evil.test/apps/brain/" } }, { kind: "capabilities" })).rejects.toThrow();
    await expect(handler({ ...f.event, sender: { ...f.event.sender, getURL: () => "https://gateway.test/apps/brain-other/" } }, { kind: "capabilities" })).rejects.toThrow();
    await expect(handler({ ...f.event, sender: { ...f.event.sender, isDestroyed: () => true } }, { kind: "capabilities" })).rejects.toThrow();
    f.setGeneration();
    await expect(handler(f.event, { kind: "capabilities" })).rejects.toThrow();
    expect(f.capabilityRequest).not.toHaveBeenCalled();
  });
  it("binds the registered origin even if gateway origin changes", async () => {
    const f = fixture();
    f.setOrigin("https://second.test");
    await expect(f.handlers.get(APP_CAPABILITY_CHANNEL)!({ ...f.event, sender: { ...f.event.sender, getURL: () => "https://second.test/apps/brain/" } }, { kind: "capabilities" })).rejects.toThrow();
    expect(f.capabilityRequest).not.toHaveBeenCalled();
  });
  it("does not deliver results after unregistering or authentication changes", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.capabilityRequest.mockImplementation(() => new Promise((done) => { resolve = done; }) as never);
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event, { kind: "capabilities" });
    f.bridge.unregister(1);
    resolve({ version: 1, integrations: true, ai: true });
    await expect(pending).rejects.toThrow("App integrations are unavailable");
  });
  it("discovers AI routes using the registered app and main frame", async () => {
    const f = fixture();
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event, {})).resolves.toEqual({ routes: [], defaultRoute: null });
    expect(f.aiRoutesRequest).toHaveBeenCalledWith("projects/brain", expect.any(AbortSignal));
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event, { app: "other" })).rejects.toThrow("App AI is unavailable");
  });
  it("redacts requester failures", async () => {
    const f = fixture();
    f.capabilityRequest.mockRejectedValue(new Error("secret token /tmp/customer"));
    await expect(f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event, { kind: "capabilities" })).rejects.toThrow(/^App integrations are unavailable$/);
  });
});

describe("native app capability HTTP transport", () => {
  it("keeps owner credentials in main and stamps the registered identity", async () => {
    const fetchFn = vi.fn(async () => Response.json({ services: [] }));
    const request = createNativeAppCapabilityRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-secret", fetchFn });
    await expect(request("projects/brain", { kind: "integrations.list" })).resolves.toEqual({ services: [] });
    expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/bridge/capabilities", expect.objectContaining({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), headers: { authorization: "Bearer owner-secret", "content-type": "application/json" }, body: JSON.stringify({ app: "projects/brain", input: { kind: "integrations.list" } }) }));
  });
  it("uses the shared attachment allowance while ordinary replies remain bounded",async()=>{
    const body={data:{content:"x".repeat(300*1024)}};
    const request=createNativeAppCapabilityRequester({getGatewayOrigin:()=>"https://gateway.test",getToken:()=>"synthetic",fetchFn:async()=>Response.json(body)});
    await expect(request("brain",{kind:"integrations.call",service:"gmail",action:"get_attachment",params:{}})).resolves.toEqual(body);
    await expect(request("brain",{kind:"integrations.list"})).rejects.toThrow("App integrations are unavailable");
  });
  it("fails closed before fetching for malformed inputs, identities and missing authentication", async () => {
    const fetchFn = vi.fn();
    const request = createNativeAppCapabilityRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => null, fetchFn });
    await expect(request("brain", { kind: "capabilities" })).rejects.toThrow();
    await expect(request("../brain", { kind: "capabilities" })).rejects.toThrow();
    await expect(request("brain", { kind: "capabilities", app: "other" } as never)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects oversized response headers and streamed output", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }));
    const request = createNativeAppCapabilityRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "secret", fetchFn });
    await expect(request("brain", { kind: "capabilities" })).rejects.toThrow(/^App integrations are unavailable$/);
    fetchFn.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } })));
    await expect(request("brain", { kind: "capabilities" })).rejects.toThrow(/^App integrations are unavailable$/);
  });
  it("bounds the entire request including a stalled response body", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const request = createNativeAppCapabilityRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "secret", fetchFn });
    const result = request("brain", { kind: "capabilities" });
    const assertion = expect(result).rejects.toThrow(/^App integrations are unavailable$/);
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].signal!.aborted).toBe(true);
  });
  it("discovers connected AI routes through the authenticated fixed endpoint", async () => {
    const fetchFn = vi.fn(async () => Response.json({ routes: [], defaultRoute: null }));
    const request = createNativeAppAiRoutesRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "secret", fetchFn });
    await expect(request("projects/brain")).resolves.toEqual({ routes: [], defaultRoute: null });
    expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/bridge/ai/routes?app=projects%2Fbrain", expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
  });
});

it("evicts old registered senders when the bounded registry fills", async () => {
  const f = fixture();
  for (let id = 2; id <= 65; id++) f.bridge.register(id, "brain");
  await expect(f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event, { kind: "capabilities" })).rejects.toThrow("App integrations are unavailable");
  expect(f.capabilityRequest).not.toHaveBeenCalled();
});

it("admits at most32 combined capability and discovery calls while offline and releases slots", async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  const offline = new Promise(done => { release = done; });
  f.capabilityRequest.mockImplementation(() => offline as never);
  f.aiRoutesRequest.mockImplementation(() => offline as never);
  const pending = Array.from({ length: 32 }, (_, index) => index % 2
    ? f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event, {})
    : f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event, { kind: "capabilities" }));
  await expect(f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event, { kind: "capabilities" })).rejects.toThrow();
  await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event, {})).rejects.toThrow();
  expect(f.capabilityRequest.mock.calls.length + f.aiRoutesRequest.mock.calls.length).toBe(32);
  release({ routes: [], defaultRoute: null });
  await Promise.all(pending);
  await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event, {})).resolves.toBeDefined();
});

it("rejects AI completion when the main frame navigates while it is pending", async () => {
  let resolve!: (value: unknown) => void;
  const aiRequest = vi.fn(() => new Promise((done) => { resolve = done; }));
  const bridge = new NativeAppBridge({ authGeneration: () => 0, generate: vi.fn(), aiRequest, request: vi.fn(), gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test" });
  bridge.register(1, "brain");
  const frame = {};
  let url = "https://gateway.test/apps/brain/";
  const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, getURL: () => url, isDestroyed: () => false } };
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  bridge.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  const pending = handlers.get("native-app:ai-generate")!(event, { prompt: "notes" });
  url = "https://gateway.test/apps/other/";
  resolve({ text: "notes" });
  await expect(pending).rejects.toThrow("App AI is unavailable");
});
