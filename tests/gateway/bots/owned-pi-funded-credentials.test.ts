import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import type { FundedAiCredentialLease, MatrixFundedCredentialProvider } from "../../../packages/gateway/src/funded-ai-credential-manager.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry, type PiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createFundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";
import { buildKernelCredentialLaunch } from "../../../packages/gateway/src/kernel-credentials.js";

const glm = "@cf/zai-org/glm-5.3-flash";
const sonnet = "claude-sonnet-5";
const relay = "https://funded.example.invalid";
const leaseToken = "test-only-gateway-lease";
let homePath: string;

beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "owned-pi-funding-"));
  await mkdir(join(homePath, "system"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(homePath, { recursive: true, force: true }); });

function setup(model = glm, requestClass: "interactive" | "background" = "interactive", recipe = false) {
  const identity = {
    runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", ownerId: "owner",
    chatId: "chat_funded", runId: "run_funded", rootFingerprint: "f".repeat(64),
    accessSourceId: "matrix_included" as const, capabilities: ["artifact.read" as const], requestClass,
    route: { api: model === glm ? "openai-completions" as const : "anthropic-messages" as const,
      modelId: model, input: ["text" as const], contextWindow: 128_000, maxOutputTokens: 4_096 },
  };
  const binding: PiRuntimeBinding = recipe
    ? { ...identity, botId: "bot_0123456789abcdef", taskId: "task_recipe" }
    : { ...identity, kind: "managed_chat", workspace: { kind: "chat_workspace" } };
  const frame: ScopeRuntimeBotInferenceRequest = {
    version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", ...identity,
    action: model === glm ? "inference.chat_completions" : "inference.messages", method: "POST",
    path: model === glm ? "/v1/chat/completions" : "/v1/messages?beta=true",
    headers: model === glm ? {} : { "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, stream: true, messages: [] }),
  };
  // Inference frames carry no owner, route, or credential supplied by the worker.
  const request = { version: frame.version, requestId: frame.requestId, runtimeHandle: frame.runtimeHandle,
    executionGeneration: frame.executionGeneration, action: frame.action, method: frame.method,
    path: frame.path, headers: frame.headers, body: frame.body };
  const registry = new BotRuntimeRegistry(); registry.bind(binding);
  const lifetime = new AbortController();
  const queue = createFundedAdmissionQueue();
  const lease: FundedAiCredentialLease = {
    token: leaseToken, tokenId: "test-token-id", relayBaseUrl: `${relay}/`,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), maxRunMs: 600_000, requestClass,
  };
  const getCredential = vi.fn<MatrixFundedCredentialProvider["getCredential"]>(async () => lease);
  const provider: MatrixFundedCredentialProvider = {
    enabled: true, maxRunMs: 600_000, getCredential, invalidate: vi.fn(), close: vi.fn(),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("data: test-only\n\n", {
    headers: { "content-type": "text/event-stream", "set-cookie": "private=1" },
  }));
  const revalidateBinding = vi.fn(async () => true);
  const actions = (fundedCredentialProvider: MatrixFundedCredentialProvider | null = provider) => createBotBrokerActions({
    // These repositories are not touched by inference. Unexpected calls fail.
    db: {} as never, sessions: {} as never, checkpoints: {} as never,
    runs: {} as never, events: {} as never, tools: {} as never, registry,
    inference: { homePath, lifetime: lifetime.signal, fundedAdmission: queue, fundedCredentialProvider: fundedCredentialProvider ?? undefined,
      fetchImpl, revalidateBinding },
  });
  return { binding, request, registry, lifetime, queue, lease, provider, getCredential, fetchImpl,
    revalidateBinding, actions, close: () => { queue.close(); registry.shutdown(); } };
}

describe("owned Pi default funded credential path", () => {
  it.each([
    [glm, "interactive", false], [sonnet, "interactive", false],
    [glm, "background", true], [sonnet, "background", true],
  ] as const)("uses the gateway lease for %s %s (recipe=%s), retaining the SDK prohibition", async (model, requestClass, recipe) => {
    const fixture = setup(model, requestClass, recipe);
    // Neither a saved owner key nor ambient SDK variables may win over Matrix funding.
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://other-account.example.invalid");
    try {
      const result = await fixture.actions().handleFrame(fixture.request);
      expect(result).toMatchObject({ ok: true, status: 200, body: "data: test-only\n\n" });
      expect(fixture.getCredential).toHaveBeenCalledOnce();
      expect(fixture.getCredential).toHaveBeenCalledWith({ requestClass, signal: expect.any(AbortSignal) });
      expect(fixture.fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fixture.fetchImpl.mock.calls[0];
      expect(url).toBe(`${relay}${fixture.request.path}`);
      expect(init).toMatchObject({ method: "POST", body: fixture.request.body, redirect: "error", signal: expect.any(AbortSignal) });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${leaseToken}`);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-matrix-funded-claim-key")).toBe(fixture.binding.runtimeHandle);
      if (model === sonnet) expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(JSON.stringify(result)).not.toMatch(/gateway-lease|ambient|owner-key|set-cookie/);
      await expect(buildKernelCredentialLaunch(homePath, {}, "matrix_included", fixture.provider, { requestClass }))
        .rejects.toThrow("Selected AI access is unavailable");
      expect(fixture.getCredential).toHaveBeenCalledOnce();
    } finally { fixture.close(); }
  });

  it.each(["missing", "failure", "empty-token", "empty-origin"] as const)("fails closed for %s credentials without an owner fallback", async (mode) => {
    const fixture = setup();
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    if (mode === "failure") fixture.getCredential.mockRejectedValue(new Error("private issuance details"));
    if (mode === "empty-token") fixture.lease.token = "";
    if (mode === "empty-origin") fixture.lease.relayBaseUrl = "";
    try {
      const result = await fixture.actions(mode === "missing" ? null : fixture.provider).handleFrame(fixture.request);
      expect(result).toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/private|owner-key|gateway-lease/);
    } finally { fixture.close(); }
  });

  it("propagates Stop to lease acquisition and never sends after it completes", async () => {
    const fixture = setup();
    let finish!: (lease: FundedAiCredentialLease) => void;
    let signal: AbortSignal | undefined;
    fixture.getCredential.mockImplementation(async (options) => {
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    try {
      const pending = fixture.actions().handleFrame(fixture.request);
      await vi.waitFor(() => expect(fixture.getCredential).toHaveBeenCalledOnce());
      fixture.registry.cancelInference(fixture.binding);
      expect(signal?.aborted).toBe(true);
      finish(fixture.lease);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });

  it.each(["generation", "model", "cancelled", "owner"] as const)("denies %s before acquiring a lease", async (mode) => {
    const fixture = setup();
    if (mode === "cancelled") fixture.registry.cancelInference(fixture.binding);
    if (mode === "owner") fixture.revalidateBinding.mockResolvedValue(false);
    const request = { ...fixture.request,
      ...(mode === "generation" ? { executionGeneration: "5" } : {}),
      ...(mode === "model" ? { body: JSON.stringify({ model: "unapproved", stream: true }) } : {}),
    };
    try {
      expect(await fixture.actions().handleFrame(request)).toMatchObject({ ok: false });
      expect(fixture.getCredential).not.toHaveBeenCalled();
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });

  it("rechecks owner/run authority after acquiring the credential", async () => {
    const fixture = setup();
    fixture.getCredential.mockImplementation(async () => {
      fixture.revalidateBinding.mockResolvedValue(false);
      return fixture.lease;
    });
    try {
      await expect(fixture.actions().handleFrame(fixture.request)).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fixture.getCredential).toHaveBeenCalledOnce();
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });

  it("rechecks authority after a capacity wait without a second send", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockImplementationOnce(async () => {
      fixture.revalidateBinding.mockResolvedValue(false);
      return new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "capacity_busy" } });
    });
    try {
      await expect(fixture.actions().handleFrame(fixture.request)).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fixture.getCredential).toHaveBeenCalledOnce();
      expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    } finally { fixture.close(); }
  });

  it("retains the explicit owner API-key path without funded credential acquisition", async () => {
    const fixture = setup(sonnet);
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    fixture.registry.bind({ ...fixture.binding, accessSourceId: "owner_anthropic_key" });
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", relay);
    try {
      await expect(fixture.actions().handleFrame(fixture.request)).resolves.toMatchObject({ ok: true });
      const [url, init] = fixture.fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("owner-key");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-matrix-funded-claim-key")).toBeNull();
      expect(fixture.getCredential).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });
});
