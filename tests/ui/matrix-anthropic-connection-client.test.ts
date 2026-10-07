import { describe, expect, it, vi } from "vitest";
import { createMatrixAnthropicConnectionClient } from "../../packages/ui/src/agents-providers/matrix-anthropic-connection-client.js";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client.js";

const generation = "47ed04c6-d276-4ec2-a9f1-f7b2e071cb3c";
const receipt = {
  connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
  revision: 2, enabled: true, credentialGeneration: generation, sourceCredentialGeneration: generation,
  state: "ready", models: [{ id: "claude-owner", displayName: "Owner Claude" }],
  actions: ["connect", "refresh", "disconnect"], checkedAt: "2026-10-07T10:00:00.000Z", staleAfter: "2026-10-07T10:05:00.000Z",
  supports: { rootChat: true, recipeBots: true },
};
const mutation = { expectedRevision: 2, expectedCredentialGeneration: generation, idempotencyKey: "c1b9249e-28b3-467d-a694-27fc64ed7e66" };

describe("Matrix Anthropic connection client", () => {
  it("uses the separate Matrix connection endpoints with exact CAS and idempotency", async () => {
    const request = vi.fn().mockResolvedValue(receipt);
    const client = createMatrixAnthropicConnectionClient(request);
    const signal = new AbortController().signal;
    expect(await client.status(signal)).toEqual(receipt);
    expect(request).toHaveBeenLastCalledWith({ path: "/api/ai/matrix-connections/anthropic", method: "GET", signal });
    await client.connect({ ...mutation, apiKey: "sk-ant-synthetic-owner-key" }, signal);
    expect(request).toHaveBeenLastCalledWith({ path: "/api/ai/matrix-connections/anthropic/connect", method: "POST", body: { ...mutation, apiKey: "sk-ant-synthetic-owner-key" }, signal });
    await client.refresh(mutation, signal);
    expect(request.mock.lastCall?.[0].path).toBe("/api/ai/matrix-connections/anthropic/refresh");
    await client.disconnect(mutation, signal);
    expect(request).toHaveBeenLastCalledWith({ path: "/api/ai/matrix-connections/anthropic/disconnect", method: "POST", body: mutation, signal });
    expect(request.mock.calls.every(([input]) => !input.path.includes("provider-settings/workflows"))).toBe(true);
  });

  it("rejects invalid secret and mutation inputs before transport", async () => {
    const request = vi.fn(); const client = createMatrixAnthropicConnectionClient(request);
    const signal = new AbortController().signal;
    await expect(client.connect({ ...mutation, apiKey: "bad\nkey" }, signal)).rejects.toThrow();
    await expect(client.disconnect({ ...mutation, expectedRevision: -1 }, signal)).rejects.toThrow();
    await expect(client.refresh({ ...mutation, expectedCredentialGeneration: "unsafe" }, signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed and credential-bearing success responses", async () => {
    const request = vi.fn().mockResolvedValue({ ...receipt, apiKey: "private-key" });
    const client = createMatrixAnthropicConnectionClient(request);
    await expect(client.status(new AbortController().signal)).rejects.toThrow();
    request.mockResolvedValue({ ...receipt, billingKind: "subscription" });
    await expect(client.status(new AbortController().signal)).rejects.toThrow();
  });

  it("never retries a denied or missing connection through native or funded routes", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderWorkflowClientError("unsupported"));
    const client = createMatrixAnthropicConnectionClient(request);
    await expect(client.connect({ ...mutation, apiKey: "sk-ant-synthetic-owner-key" }, new AbortController().signal)).rejects.toMatchObject({ reason: "unsupported" });
    expect(request).toHaveBeenCalledOnce();
    request.mockClear().mockRejectedValue(new ProviderWorkflowClientError("forbidden"));
    await expect(client.status(new AbortController().signal)).rejects.toMatchObject({ reason: "forbidden" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("fences a late successful response after cancellation", async () => {
    let settle!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { settle = resolve; }));
    const controller = new AbortController();
    const pending = createMatrixAnthropicConnectionClient(request).status(controller.signal);
    controller.abort(); settle(receipt);
    await expect(pending).rejects.toThrow();
  });
});
