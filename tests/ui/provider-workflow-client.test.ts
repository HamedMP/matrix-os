import { describe, expect, it, vi } from "vitest";
import { createProviderWorkflowClient } from "../../packages/ui/src/agents-providers/provider-workflow-client.js";

const operation = { id: "operation_1", harnessInstanceId: "codex_default", kind: "login", state: "running",
  expiresAt: "2026-10-01T12:00:00.000Z", terminalSessionId: null, deviceCode: "ABCD-EFGH",
  authorizationUrl: "https://auth.openai.com/codex/device", safeFailure: null };

describe("provider workflow client boundary", () => {
  it("validates operation responses and uses separate workflow endpoints", async () => {
    const request = vi.fn().mockResolvedValue(operation);
    const client = createProviderWorkflowClient(request);
    const signal = new AbortController().signal;
    expect(await client.get("operation_1", signal)).toEqual(operation);
    expect(request).toHaveBeenCalledWith({ method: "GET", path: "/api/ai/provider-settings/workflows/v2/operation_1", signal });
    await client.cancel("operation_1", signal);
    expect(request).toHaveBeenLastCalledWith({ method: "POST", path: "/api/ai/provider-settings/workflows/operation_1/cancel", body: {}, signal });
  });

  it("rejects unsafe references and secrets before sending requests", async () => {
    const request = vi.fn();
    const client = createProviderWorkflowClient(request);
    const signal = new AbortController().signal;
    await expect(client.get("../../owner", signal)).rejects.toThrow("Provider action is unavailable.");
    await expect(client.submitKey({ harnessInstanceId: "codex_default", providerId: "openai", apiKey: "bad\nsecret" }, signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not trust malformed or credential-bearing successful responses", async () => {
    const request = vi.fn().mockResolvedValue({ ...operation, authorizationUrl: "https://evil.example/login" });
    const client = createProviderWorkflowClient(request);
    await expect(client.get("operation_1", new AbortController().signal)).rejects.toThrow();
    request.mockResolvedValue({ verified: true, apiKey: "must-not-propagate" });
    await expect(client.submitKey({ harnessInstanceId: "codex_default", providerId: "openai", apiKey: "sk-test-value" }, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects completion after caller cancellation even if transport ignores abort", async () => {
    const caller = new AbortController();
    let resolve!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(done => { resolve = done; }));
    const pending = createProviderWorkflowClient(request).get("operation_1", caller.signal);
    caller.abort();
    resolve(operation);
    await expect(pending).rejects.toThrow();
  });
});

it("negotiates provider-aware discovery without silently falling back on denial", async () => {
  const request = vi.fn().mockRejectedValue(new (await import("../../packages/ui/src/agents-providers/provider-workflow-client.js")).ProviderWorkflowClientError("forbidden"));
  await expect(createProviderWorkflowClient(request).capabilities(new AbortController().signal)).rejects.toMatchObject({reason: "forbidden"});
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0].path).toBe("/api/ai/provider-settings/workflows/v2/capabilities");
});

it("falls back only a missing V2 read and never retries a connection write", async () => {
 const {ProviderWorkflowClientError} = await import("../../packages/ui/src/agents-providers/provider-workflow-client.js");
 const request = vi.fn().mockRejectedValueOnce(new ProviderWorkflowClientError("unsupported")).mockResolvedValueOnce([]);
 const client = createProviderWorkflowClient(request);
 await expect(client.capabilities(new AbortController().signal)).resolves.toEqual([]);
 expect(request.mock.calls.map(([value]) => value.path)).toEqual(["/api/ai/provider-settings/workflows/v2/capabilities", "/api/ai/provider-settings/workflows/capabilities?connectionVersion=2"]);
 request.mockClear().mockRejectedValue(new ProviderWorkflowClientError("unsupported"));
 await expect(client.submitConnectionKey!({harnessInstanceId: "pi", optionId: "pi:anthropic:key", apiKey: "synthetic-key"}, new AbortController().signal)).rejects.toMatchObject({reason: "unsupported"});
 expect(request).toHaveBeenCalledOnce();
});

it("retains exact provider receipt and versioned cancellation after recovery", async () => {
 const connectionOption = {id: "pi:openai:device", providerId: "openai", authKind: "subscription", method: "device_code", billingKind: "subscription", executionKind: "native", availability: "available"};
 const request = vi.fn().mockResolvedValue({...operation, connectionOption});
 const client = createProviderWorkflowClient(request);
 const signal = new AbortController().signal;
 expect((await client.get("operation_1", signal)).connectionOption).toEqual(connectionOption);
 await client.cancel("operation_1", signal);
 expect(request).toHaveBeenLastCalledWith({method: "POST", path: "/api/ai/provider-settings/workflows/v2/operation_1/cancel", body: {}, signal});
});
