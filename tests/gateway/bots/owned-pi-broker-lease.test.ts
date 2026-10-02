import { expect, it, vi } from "vitest";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { buildKernelCredentialLaunch } from "../../../packages/gateway/src/kernel-credentials.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { MatrixFundedCredentialProvider } from "../../../packages/gateway/src/funded-ai-credential-manager.js";

it.each([
  ["inference.chat_completions", "/v1/chat/completions", "@cf/zai-org/glm-5.3-flash"],
  ["inference.messages", "/v1/messages", "claude-sonnet-5"],
] as const)("uses the default owned Pi broker lease for %s while rejecting the legacy SDK", async (action, path, model) => {
  const runtimeHandle = `runtime_${"a".repeat(32)}`;
  const getCredential = vi.fn(async () => ({ token: "synthetic-lease-token", tokenId: "lease", expiresAt: "2026-10-04T00:00:00.000Z",
    relayBaseUrl: "https://relay.example.invalid", maxRunMs: 600_000, requestClass: "interactive" as const }));
  const provider: MatrixFundedCredentialProvider = { enabled: true, maxRunMs: 600_000, getCredential, invalidate: vi.fn(), close: vi.fn() };
  const binding = { runtimeHandle, executionGeneration: "1", kind: "managed_chat", ownerId: "owner", chatId: "chat", runId: "run",
    workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included",
    capabilities: ["artifact.read"], requestClass: "interactive", route: { modelId: model } } as ManagedPiRuntimeBinding;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: {"result":"ok"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const body = JSON.stringify({ model, stream: true, messages: [] });
  const result = await forwardBotInference({ version: 1, action, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
    runtimeHandle, executionGeneration: "1", method: "POST", path, headers: {}, body }, binding,
    () => ({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] }),
    { homePath: "/unused-owner-home", lifetime: new AbortController().signal, fundedCredentialProvider: provider, fetchImpl });
  expect(result).toMatchObject({ ok: true, status: 200 });
  expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "interactive", signal: expect.any(AbortSignal) }));
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe(`https://relay.example.invalid${path}`);
  const headers = new Headers(init!.headers);
  expect(headers.get("authorization")).toBe("Bearer synthetic-lease-token");
  expect(headers.has("x-api-key")).toBe(false);
  expect(headers.get("x-matrix-funded-claim-key")).toBe(runtimeHandle);
  expect(init).toMatchObject({ body, redirect: "error", signal: expect.any(AbortSignal) });
  expect(JSON.stringify(result)).not.toContain("synthetic-lease-token");
  getCredential.mockClear();
  await expect(buildKernelCredentialLaunch("/unused-owner-home", {}, "matrix_included", provider, { requestClass: "interactive" })).rejects.toThrow();
  expect(getCredential).not.toHaveBeenCalled();
});


it.each(["disabled", "cancelled_before", "cancelled_after", "revoked_after"] as const)(
  "keeps default owned Pi funded credentials fail-closed for %s", async (state) => {
    const lifetime = new AbortController();
    if (state === "cancelled_before") lifetime.abort();
    let authorized = true;
    const getCredential = vi.fn(async () => {
      if (state === "cancelled_after") lifetime.abort();
      if (state === "revoked_after") authorized = false;
      return { token: "synthetic-private-lease", tokenId: "lease", expiresAt: "2026-10-04T00:00:00.000Z",
        relayBaseUrl: "https://relay.example.invalid", maxRunMs: 600_000, requestClass: "background" as const };
    });
    const provider: MatrixFundedCredentialProvider = { enabled: true, maxRunMs: 600_000,
      getCredential, invalidate: vi.fn(), close: vi.fn() };
    const model = "@cf/zai-org/glm-5.3-flash";
    const runtimeHandle = `runtime_${"b".repeat(32)}`;
    const binding = { runtimeHandle, executionGeneration: "1", kind: "managed_chat", ownerId: "owner", chatId: "chat", runId: "run",
      workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included",
      capabilities: ["artifact.read"], requestClass: "background", route: { modelId: model } } as ManagedPiRuntimeBinding;
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await forwardBotInference({ version: 1, action: "inference.chat_completions",
      requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle, executionGeneration: "1",
      method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model, stream: true, messages: [] }) },
      binding, () => ({ allowed: authorized, accessSourceId: "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] }),
      { homePath: "/unused-owner-home", lifetime: lifetime.signal,
        ...(state !== "disabled" ? { fundedCredentialProvider: provider } : {}), fetchImpl });
    expect(result).toMatchObject({ ok: false, error: state === "disabled" ? "provider_unavailable" : "action_denied" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic-private-lease");
    if (state === "disabled" || state === "cancelled_before") expect(getCredential).not.toHaveBeenCalled();
    else expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "background", signal: lifetime.signal }));
  },
);
