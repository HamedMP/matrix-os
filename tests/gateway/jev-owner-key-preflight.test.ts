import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createOwnerAnthropicKeyPreflight } from "../../packages/gateway/src/ai-providers/owner-key-preflight.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProductionJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-production.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jev-owner-health-")); const homePath = join(directory, "home");
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-api03-synthetic-only" } }));
  await writeFile(join(homePath, "system/ai-providers/settings.json"), JSON.stringify({ schemaVersion: 1, revision: 1,
    receipts: [], gatewayPolicy: null, accountProfiles: [{ id: "owner_anthropic", providerId: "anthropic", displayName: "Owner",
      authMethod: "api_key", accessSourceId: "owner_anthropic_key" }], harnesses: [{ id: "harness_hermes", driverId: "hermes",
      harness: "hermes", displayName: "Hermes", accentColor: null, enabled: true, selectedAccountId: "owner_anthropic",
      accessSourceId: "owner_anthropic_key", route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" } }] }));
  const count = vi.fn<typeof fetch>(async (raw, init) => {
    expect(String(raw)).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Health check." }] });
    return Response.json({ input_tokens: 17 });
  });
  vi.stubGlobal("fetch", count);
  // Exact production construction: no synthetic ready observation and no ambient credentials.
  const service = new AiProviderService({ homePath, env: {}, healthProbe: createOwnerAnthropicKeyPreflight({ homePath }), driverInventory: async () => [{ id: "hermes", displayName: "Hermes",
    kind: "cli", installState: "installed", health: "ready", capabilities: ["tools", "resume"], setupActions: [] }] });
  const settings = new ProviderSettingsStore({ homePath, privateRootPath: join(directory, "private"), providerSnapshotReader: service });
  const runtime = createProductionJevInboxRuntime({ homePath, ownerId: "owner_fixture", settings, getAgent: async () => null,
    service: null, internalBaseUrl: null });
  return { homePath, settings, count,
    resolve: (signal = new AbortController().signal) => runtime.launch.resolveCredentials("owner_fixture", { instanceId: "hermes_default", model: "anthropic:claude-sonnet-5" }, signal),
    close: async () => { runtime.close(); service.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); } };
}
it("a production owner-key recipe gains exact-model auth health through V3, without a synthetic healthProbe", async () => {
  const f = await fixture();
  try {
    const before = await f.settings.getSnapshot({ refresh: true });
    expect(before.accessSources.find(source => source.id === "owner_anthropic_key")?.readiness.state).toBe("unknown");
    expect(f.count).not.toHaveBeenCalled();
    await expect(f.resolve())
      .resolves.toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", apiMode: "anthropic_messages" });
    expect(f.count).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(["denied", "accepted-incomplete", "redirect", "malformed", "oversized", "declared-overflow", "invalid-utf8", "empty-body"])("keeps V3/recipe fail-closed on %s", async mode => {
  const f = await fixture(); const cancelled = vi.fn();
  try {
    f.count.mockImplementation(async () => {
      if (mode === "accepted-incomplete") return Response.json({ input_tokens: 17 }, { status: 202 });
      if (mode === "denied") return new Response("private upstream error", { status: 401 });
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://private.example.test" } });
      if (mode === "malformed") return Response.json({ input_tokens: -1, rawKey: "not-for-projection" });
      if (mode === "empty-body") return new Response(null);
      if (mode === "invalid-utf8") return new Response(new Uint8Array([255]));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1025))); }, cancel: cancelled }),
        mode === "declared-overflow" ? { headers: { "content-length": "2048" } } : undefined);
    });
    await expect(f.resolve()).rejects.toThrow();
    expect(f.count).toHaveBeenCalledOnce();
    if (mode === "oversized" || mode === "declared-overflow") expect(cancelled).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it.each(["key", "model", "revision"])("rejects delayed auth health after %s rotation", async mode => {
  const f = await fixture(); const response = Promise.withResolvers<Response>();
  f.count.mockImplementation(async () => response.promise);
  try {
    const pending = f.resolve(); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.count).toHaveBeenCalledOnce());
    const path = join(f.homePath, mode === "key" ? "system/config.json" : "system/ai-providers/settings.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    if (mode === "key") config.kernel.anthropicApiKey = "sk-ant-api03-rotated-synthetic";
    if (mode === "model") config.harnesses[0].route.modelId = "claude-opus-5";
    if (mode === "revision") config.revision++;
    await writeFile(path, JSON.stringify(config));
    response.resolve(Response.json({ input_tokens: 17 })); await rejected;
  } finally { response.resolve(Response.json({ input_tokens: 17 })); await f.close(); }
});
it("does not leak recipe health into ordinary Settings or reuse cache after key rotation", async () => {
  const f = await fixture();
  try {
    await f.resolve(); await f.resolve(); expect(f.count).toHaveBeenCalledOnce();
    const ordinary = await f.settings.getSnapshot({ refresh: true });
    expect(ordinary.accessSources.find(s => s.id === "owner_anthropic_key")?.readiness.state).toBe("unknown");
    expect(f.count).toHaveBeenCalledOnce();
    await writeFile(join(f.homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-api03-rotated-synthetic" } }));
    f.count.mockImplementation(async (_raw, init) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-api03-rotated-synthetic");
      return new Response(null, { status: 401 });
    });
    await expect(f.resolve()).rejects.toThrow(); expect(f.count).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
it("cancels a stalled body, denies readiness and retains only one unfinished endpoint attempt", async () => {
  const f = await fixture(); const cancelled = vi.fn(); const controller = new AbortController();
  f.count.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"input_tokens":')); }, cancel: cancelled })));
  try {
    const pending = f.resolve(controller.signal); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.count).toHaveBeenCalledOnce()); controller.abort(); await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    const ordinary = await f.settings.getSnapshot({ refresh: true });
    expect(ordinary.accessSources.find(s => s.id === "owner_anthropic_key")?.readiness.state).toBe("unknown");
  } finally { await f.close(); }
});
it("does not create another unfinished request after abort even if fetch ignores its signal", async () => {
  const f = await fixture(); const response = Promise.withResolvers<Response>(); const cancelled = vi.fn();
  f.count.mockImplementation(async () => response.promise);
  const controller = new AbortController();
  try {
    const pending = f.resolve(controller.signal); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.count).toHaveBeenCalledOnce()); controller.abort(); await rejected;
    await expect(f.resolve()).rejects.toThrow(); expect(f.count).toHaveBeenCalledOnce();
    response.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    f.count.mockResolvedValue(Response.json({ input_tokens: 17 }));
    await expect(f.resolve()).resolves.toMatchObject({ provider: "anthropic" }); expect(f.count).toHaveBeenCalledTimes(2);
  } finally { response.resolve(Response.json({ input_tokens: 17 })); await f.close(); }
});
it.each(["missing-key", "disabled", "wrong-account", "wrong-model"])("does not even count tokens for %s", async mode => {
  const f = await fixture();
  try {
    const path = join(f.homePath, mode === "missing-key" ? "system/config.json" : "system/ai-providers/settings.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    if (mode === "missing-key") config.kernel.anthropicApiKey = "";
    if (mode === "disabled") config.harnesses[0].enabled = false;
    if (mode === "wrong-account") config.harnesses[0].selectedAccountId = "other_account";
    if (mode === "wrong-model") config.harnesses[0].route.modelId = "claude-opus-5";
    await writeFile(path, JSON.stringify(config));
    await expect(f.resolve()).rejects.toThrow(); expect(f.count).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it("bounds a stalled endpoint at the existing two-second readiness deadline", async () => {
  const f = await fixture(); const response = Promise.withResolvers<Response>(); const cancelled = vi.fn();
  f.count.mockImplementation(async () => response.promise);
  try {
    const start = performance.now(); await expect(f.resolve()).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(2_750);
    await expect(f.resolve()).rejects.toThrow(); expect(f.count).toHaveBeenCalledOnce();
    response.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  } finally { response.resolve(Response.json({ input_tokens: 17 })); await f.close(); }
});
it("expires the exact-fingerprint health cache after thirty seconds", async () => {
  const f = await fixture(); let now = Date.now();
  const probe = createOwnerAnthropicKeyPreflight({ homePath: f.homePath, fetchFn: f.count, now: () => now });
  const { ownerKeyFingerprint } = await import("../../packages/gateway/src/ai-providers/owner-key-preflight.js");
  const context = { modelId: "claude-sonnet-5", credentialFingerprint: ownerKeyFingerprint("sk-ant-api03-synthetic-only") };
  try {
    expect((await probe("owner_anthropic_key", new AbortController().signal, context))?.state).toBe("ready");
    now += 29_999;
    expect((await probe("owner_anthropic_key", new AbortController().signal, context))?.state).toBe("ready"); expect(f.count).toHaveBeenCalledOnce();
    now++;
    expect((await probe("owner_anthropic_key", new AbortController().signal, context))?.state).toBe("ready"); expect(f.count).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
