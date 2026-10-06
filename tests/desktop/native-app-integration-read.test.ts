import { describe, expect, it, vi } from "vitest";
import { NativeAppBridge, createNativeAppIntegrationRequester } from "../../desktop/src/main/embeds/native-app-bridge";
import { prepareAppIntegrationRequest } from "../../shell/src/components/app-integration-request";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { createAppIntegrationClient } from "../../packages/contracts/src/app-integrations";

const input = { service: "github", action: "list_prs", connectionId: "owned", label: "Work", params: { repo: "example/project" } };
describe("app integration trusted identity parity", () => {
  it("binds web app identity and disallows identity aliases and actor injection", () => {
    const bound = prepareAppIntegrationRequest("briefing", "/api/bridge/integrations", { method: "POST", body: JSON.stringify(input) });
    expect(JSON.parse(bound.init.body as string)).toEqual({ app: "briefing", ...input });
    expect(prepareAppIntegrationRequest("briefing", "/api/bridge/integrations", {}).url).toBe("/api/bridge/integrations?app=briefing");
    for (const url of ["/api/bridge/integrations?app=other", "/api/bridge/integrations/", "/api/bridge/%69ntegrations"]) {
      expect(isAllowedBridgeFetchUrl("briefing", url)).toBe(false);
    }
    expect(() => prepareAppIntegrationRequest("briefing", "/api/bridge/integrations", { method: "POST", body: JSON.stringify({ ...input, app: "other" }) })).toThrow();
  });
  it("native IPC checks registered sender, path and auth generation and never accepts an app identity", async () => {
    let generation = 1;
    const integrationRequest = vi.fn(async () => ({ data: [] }));
    const bridge = new NativeAppBridge({ authGeneration: () => generation, gatewayOrigin: () => "https://runtime.example",
      generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), integrationRequest });
    bridge.register(1, "briefing");
    const sender = { id: 1, url: "https://runtime.example/apps/briefing/" };
    await bridge.integrationRead(sender, { type: "call", input });
    expect(integrationRequest).toHaveBeenCalledWith("briefing", { type: "call", input });
    integrationRequest.mockClear();
    for (const bad of [{ ...sender, id: 2 }, { ...sender, url: "https://foreign.example/apps/briefing" }]) {
      await expect(bridge.integrationRead(bad, { type: "inventory" })).rejects.toThrow();
    }
    await expect(bridge.integrationRead(sender, { type: "call", input: { ...input, app: "other" } })).rejects.toThrow();
    generation++;
    await expect(bridge.integrationRead(sender, { type: "inventory" })).rejects.toThrow();
    expect(integrationRequest).not.toHaveBeenCalled();
  });
  it("native request keeps bearer in main and generates the same app-bound route", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const request = createNativeAppIntegrationRequester({ getGatewayOrigin: () => "https://runtime.example", getToken: () => "test-only-bearer", fetchFn });
    await request("briefing", { type: "call", input });
    expect(fetchFn).toHaveBeenCalledWith("https://runtime.example/api/bridge/integrations", expect.objectContaining({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), body: JSON.stringify({ app: "briefing", ...input }) }));
    await request("briefing", { type: "inventory" });
    expect(fetchFn).toHaveBeenLastCalledWith("https://runtime.example/api/bridge/integrations?app=briefing", expect.objectContaining({ method: "GET" }));
  });
  it("native app client sends only typed read operations and sanitizes provider failure", async () => {
    const invoke = vi.fn(async () => { throw new Error("private provider detail"); });
    const client = createAppIntegrationClient(invoke);
    await expect(client.serviceRead(input.service, input.action, input.params, input.connectionId, input.label)).rejects.toThrow("App integration read is unavailable");
    expect(invoke).toHaveBeenCalledWith({ type: "call", input });
  });
});

it("binds native app job controls without exposing another app, sources or grants", async () => {
  const { createNativeAppReadJobRequester } = await import("../../desktop/src/main/embeds/native-app-bridge");
  const fetchFn = vi.fn(async () => Response.json({ status: "accepted" }));
  const request = createNativeAppReadJobRequester({ getGatewayOrigin: () => "https://runtime.example", getToken: () => "test-token", fetchFn });
  await request("briefing", { action: "run", input: { jobId: "daily" } });
  expect(fetchFn).toHaveBeenCalledWith("https://runtime.example/api/app-read-jobs/run", expect.objectContaining({ body: JSON.stringify({ app: "briefing", jobId: "daily" }), method: "POST", redirect: "error" }));
  await expect(request("briefing", { action: "run", input: { jobId: "daily", app: "other" } } as never)).rejects.toThrow();
  const readJobRequest = vi.fn(async () => ({ status: "accepted" }));
  const bridge = new NativeAppBridge({ authGeneration: () => 1, gatewayOrigin: () => "https://runtime.example", generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), readJobRequest });
  bridge.register(1, "briefing");
  await bridge.readJob({ id: 1, url: "https://runtime.example/apps/briefing/" }, { action: "run", input: { jobId: "daily" } });
  expect(readJobRequest).toHaveBeenCalledWith("briefing", { action: "run", input: { jobId: "daily" } });
  await expect(bridge.readJob({ id: 1, url: "https://runtime.example/apps/other/" }, { action: "run", input: { jobId: "daily" } })).rejects.toThrow();
});

it("binds Web job actions and rejects alternate app, source grants and unsafe settings", async () => {
  const { prepareAppReadJobRequest } = await import("../../shell/src/components/app-read-job-request");
  const { AppReadJobSettingsSchema } = await import("../../packages/contracts/src/app-read-jobs");
  const bound = prepareAppReadJobRequest("briefing", "/api/app-read-jobs/pause", { method: "POST", body: JSON.stringify({ jobId: "daily", paused: true }) });
  expect(JSON.parse(bound.body as string)).toEqual({ app: "briefing", jobId: "daily", paused: true });
  for (const url of ["/api/app-read-jobs/run?app=other", "/api/app-read-jobs/run/", "/api/app-read-jobs/%72un", "/api/app-read-jobs/configure?x=1"]) expect(isAllowedBridgeFetchUrl("briefing", url)).toBe(false);
  expect(() => prepareAppReadJobRequest("briefing", "/api/app-read-jobs/run", { method: "POST", body: JSON.stringify({ app: "other", jobId: "daily" }) })).toThrow();
  expect(AppReadJobSettingsSchema.safeParse({ sources: [{ id: "feedback", service: "slack", connectionId: "owned", label: "Work", params: { channel: "C123456", token: "secret" } }] }).success).toBe(false);
  expect(AppReadJobSettingsSchema.safeParse({ sources: [{ id: "feedback", service: "slack", connectionId: "owned", label: "Work", params: { channel: "D123456" } }] }).success).toBe(false);
  expect(AppReadJobSettingsSchema.safeParse({ sources: [{ id: "repo", service: "github", connectionId: "owned", label: "Work", params: { repo: "example/project" } }] }).success).toBe(true);
});
