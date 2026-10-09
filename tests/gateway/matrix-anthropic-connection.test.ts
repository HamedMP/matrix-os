import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMatrixAnthropicConnectionService } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { createMatrixAnthropicSourceStore } from "../../packages/gateway/src/ai-providers/matrix-anthropic-source.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { readOwnerAnthropicKey, revokeOwnerAnthropicKey } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { storeApiKey } from "../../packages/gateway/src/onboarding/api-key.js";
import type { PiRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import * as persistence from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import * as boundedJson from "../../packages/gateway/src/bounded-json-file.js";
import { createNativeProviderWriterLease } from "../../packages/gateway/src/ai-providers/native-provider-writer-lease.js";
const homes: string[] = []; // capped by suite fixture count, drained after every test
const request = { apiKey: "sk-ant-synthetic-only", expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "connect-1" };
const model = { type: "model", id: "claude-synthetic-model", display_name: "Synthetic Claude", max_input_tokens: 200000, max_tokens: 8192, capabilities: { image_input: { supported: true } } };
const page = () => Response.json({ data: [model], has_more: false, last_id: model.id });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(async home => {
  await rm(home, { recursive: true, force: true }); await rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true });
})); });
async function fixture(fetcher = vi.fn<typeof fetch>(async () => page())) {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-service-")); homes.push(home);
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { async get() { throw Object.assign(new Error("synthetic missing"), { code: "session_not_found" }); }, async observeAgentLiveness() { return "stopped"; } } });
  const store = createMatrixAnthropicSourceStore({ homePath: home, profileGuard: guard }); let now = Date.now(); const changed = vi.fn();
  const service = createMatrixAnthropicConnectionService({ homePath: home, ownerId: "owner", sourceStore: store,
    supports: { rootChat: true, recipeBots: true }, onSourceChanged: changed, fetch: fetcher, now: () => now, ttlMs: 60000 });
  return { home, guard, store, service, fetcher, changed, advance: () => { now += 60001; } };
}
const selection = (status: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["service"]["observe"]>>, instanceId = "matrix_pi_anthropic_api") => ({ instanceId, model: model.id,
  options: [{ id: "connectionRevision", value: String(status.revision) }, { id: "credentialGeneration", value: status.credentialGeneration! }] });
it("checks owner before reads/probes and observes without implicit discovery or enabling", async () => {
  const { service, fetcher } = await fixture();
  await expect(service.connect("other", request)).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.observe("other")).rejects.toMatchObject({ code: "forbidden" });
  expect(await service.observe("owner")).toMatchObject({ state: "disconnected", enabled: false, revision: 0, models: [] });
  expect(fetcher).not.toHaveBeenCalled(); await service.shutdown();
});
it("qualifies actual Models data, binds exact source/key, reuses status and fences expiry/revoke", async () => {
  const { service, fetcher, home, advance } = await fixture();
  const status = await service.connect("owner", request);
  expect(status).toMatchObject({ state: "ready", revision: 1, models: [{ id: model.id, displayName: model.display_name }] });
  expect(JSON.stringify(status)).not.toContain(request.apiKey);
  const [url, init] = fetcher.mock.calls[0]!; expect(String(url)).toMatch(/^https:\/\/api.anthropic.com\/v1\/models\?/);
  expect(init).toMatchObject({ method: "GET", redirect: "error" }); expect(init?.signal).toBeInstanceOf(AbortSignal);
  await service.observe("owner"); await service.observe("owner"); expect(fetcher).toHaveBeenCalledTimes(1);
  const resolved = await service.resolve(selection(status), "owner", "interactive");
  expect(resolved).toMatchObject({ accessSourceId: "owner_anthropic_key", anthropicApi: { connectionRevision: 1, credentialGeneration: status.credentialGeneration }, route: { api: "anthropic-messages", input: ["text", "image"] } });
  const binding = { ownerId: "owner", kind: "managed_chat", requestClass: "interactive", ...resolved } as PiRuntimeBinding;
  expect(await service.revalidate(binding, new AbortController().signal)).toBe(true);
  expect(await service.credential(binding, new AbortController().signal)).toBe(request.apiKey);
  advance(); expect(await service.observe("owner")).toMatchObject({ state: "refresh_required", models: [] });
  expect(await service.revalidate(binding, new AbortController().signal)).toBe(false);
  await revokeOwnerAnthropicKey(home);
  const revoked = await service.observe("owner"); expect(revoked).toMatchObject({ state: "auth_required", models: [] });
  expect(revoked.credentialGeneration).toBeTruthy(); expect(revoked.credentialGeneration).not.toBe(status.credentialGeneration);
  await expect(service.credential(binding, new AbortController().signal)).rejects.toThrow(); await service.shutdown();
});
it("does not probe or replay exact Connect retry after Disconnect, and preserves shared native key", async () => {
  const { service, fetcher, home } = await fixture(); const connected = await service.connect("owner", request);
  const disabled = await service.disconnect("owner", { expectedRevision: 1, expectedCredentialGeneration: connected.credentialGeneration, idempotencyKey: "disconnect-1" });
  expect(disabled).toMatchObject({ state: "disconnected", enabled: false, revision: 2 });
  expect((await readOwnerAnthropicKey(home)).key).toBe(request.apiKey);
  expect(await service.connect("owner", request)).toMatchObject({ enabled: false, revision: 2 }); expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(service.connect("owner", { ...request, apiKey: "sk-ant-another" })).rejects.toMatchObject({ code: "conflict" }); await service.shutdown();
});
it("preserves a newer qualified connection when an old Disconnect receipt is retried", async () => {
  const { service, changed, fetcher } = await fixture();
  const first = await service.connect("owner", request);
  const disconnect = { expectedRevision: first.revision, expectedCredentialGeneration: first.credentialGeneration, idempotencyKey: "old-disconnect" };
  const disabled = await service.disconnect("owner", disconnect);
  const current = await service.connect("owner", { ...request, apiKey: "sk-ant-current-synthetic", expectedRevision: disabled.revision,
    expectedCredentialGeneration: disabled.credentialGeneration, idempotencyKey: "reconnect-current" });
  expect(current.state).toBe("ready");
  expect(await service.disconnect("owner", disconnect)).toEqual(current);
  await expect(service.resolve(selection(current, "matrix_anthropic_api"), "owner", "interactive")).resolves.toMatchObject({ accessSourceId: "owner_anthropic_key" });
  expect(changed).toHaveBeenCalledTimes(3); expect(fetcher).toHaveBeenCalledTimes(2);
  await service.shutdown();
});
it("rejects native replacement during Models discovery and never publishes late qualification", async () => {
  let resolveProbe!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { resolveProbe = resolve; }));
  const { service, home, store } = await fixture(fetcher);
  const pending = service.connect("owner", request); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await storeApiKey(home, "sk-ant-native-current"); resolveProbe(page());
  await expect(pending).rejects.toMatchObject({ code: "conflict" }); expect(await store.read()).toMatchObject({ revision: 0, enabled: false });
  expect((await readOwnerAnthropicKey(home)).key).toBe("sk-ant-native-current"); await service.shutdown();
});
it("refreshes captured source without enabling/revising, expires safely, rejects stale probe results and permits recovery", async () => {
  const { service, store, fetcher, home, advance } = await fixture(); const status = await service.connect("owner", request); advance();
  const refresh = { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "refresh-1" };
  expect(await service.refresh("owner", refresh)).toMatchObject({ state: "ready", revision: 1 });
  expect((await store.read()).revision).toBe(1); await service.refresh("owner", refresh); expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(service.refresh("owner", { ...refresh, expectedRevision: 2 })).rejects.toMatchObject({ code: "conflict" });
  let finish!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const late = service.refresh("owner", { ...refresh, idempotencyKey: "late-refresh" }); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  await storeApiKey(home, "sk-ant-new-native"); finish(page()); await expect(late).rejects.toMatchObject({ code: "conflict" });
  expect(await service.observe("owner")).toMatchObject({ state: "auth_required", models: [] }); await service.shutdown();
});
it("rejects provider failures and malformed/oversized/unbounded pagination without replacing prior key/source", async () => {
  const { service, home, fetcher, store } = await fixture(); const status = await service.connect("owner", request);
  const replacement = { ...request, expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "replace" };
  for (const response of [new Response("secret upstream detail", { status: 401 }), Response.json({ data: [{ ...model, max_tokens: null }], has_more: false, last_id: model.id }),
    Response.json({ data: [{ ...model, max_input_tokens: 1, max_tokens: 1 }], has_more: false, last_id: model.id }),
    new Response("x".repeat(262145)), Response.json({ data: [model, model], has_more: false, last_id: model.id })]) {
    fetcher.mockResolvedValueOnce(response); await expect(service.connect("owner", replacement)).rejects.toThrow();
    expect((await readOwnerAnthropicKey(home)).key).toBe(request.apiKey); expect(await store.read()).toMatchObject({ enabled: true, revision: 1 });
  }
  fetcher.mockImplementation(async () => Response.json({ data: [model], has_more: true, last_id: model.id }));
  await expect(service.connect("owner", replacement)).rejects.toMatchObject({ code: "unavailable" });
  await service.shutdown();
});
it("caps queued discovery, drains on shutdown and forbids stale/cancelled/mixed runtime authority", async () => {
  const { service, fetcher } = await fixture(); const status = await service.connect("owner", request);
  const route = await service.resolve(selection(status, "matrix_anthropic_api"), "owner", "background");
  const binding = { ownerId: "owner", requestClass: "background", ...route } as PiRuntimeBinding;
  const controller = new AbortController(); controller.abort(); expect(await service.revalidate(binding, controller.signal)).toBe(false);
  await expect(service.resolve({ ...selection(status), options: [] }, "owner", "interactive")).rejects.toThrow();
  await expect(service.resolve(selection(status), "owner", "background")).rejects.toThrow();
  expect(await service.revalidate({ ...binding, ownerId: "other" }, new AbortController().signal)).toBe(false);
  expect(await service.revalidate({ ...binding, subscription: { peerId: "synthetic" } } as PiRuntimeBinding, new AbortController().signal)).toBe(false);
  fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("synthetic cancellation")), { once: true })));
  const replace = { ...request, expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration };
  const tasks = Array.from({ length: 8 }, (_, index) => service.connect("owner", { ...replace, idempotencyKey: `pending-${index}` }).catch(error => error));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await expect(service.connect("owner", { ...replace, idempotencyKey: "exceeds-cap" })).rejects.toMatchObject({ code: "unavailable" });
  await service.shutdown(); expect((await Promise.all(tasks)).every(error => error instanceof Error)).toBe(true);
  expect(await service.revalidate(binding, new AbortController().signal)).toBe(false); await expect(service.observe("owner")).rejects.toThrow();
});

it("failed explicit refresh removes usable qualification without disabling intent or changing key", async () => {
  const { service, fetcher, store, home } = await fixture(); const status = await service.connect("owner", request);
  fetcher.mockResolvedValueOnce(new Response("synthetic upstream rejection", { status: 401 }));
  await expect(service.refresh("owner", { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "failed-refresh" })).rejects.toMatchObject({ code: "rejected" });
  expect(await service.observe("owner")).toMatchObject({ state: "refresh_required", models: [], enabled: true });
  expect(await store.read()).toMatchObject({ revision: 1, enabled: true }); expect((await readOwnerAnthropicKey(home)).key).toBe(request.apiKey);
  await service.shutdown();
});
it("does not claim executable capability on unsupported or read-only runtimes", async () => {
  const { service, home, store, fetcher } = await fixture(); await service.connect("owner", request);
  for (const options of [{ supports: { rootChat: false, recipeBots: false } }, { supports: { rootChat: true, recipeBots: true }, readOnly: true }]) {
    const denied = createMatrixAnthropicConnectionService({ homePath: home, ownerId: "owner", sourceStore: store, fetch: fetcher, ...options });
    expect(await denied.observe("owner")).toMatchObject({ state: options.readOnly ? "read_only" : "unsupported", models: [], actions: [], supports: { rootChat: false, recipeBots: false } });
    await expect(denied.connect("owner", request)).rejects.toMatchObject({ code: "unavailable" }); await denied.shutdown();
  }
  expect(fetcher).toHaveBeenCalledTimes(1); await service.shutdown();
});

it("notifies accepted source publications once, excludes refresh/retries, and preserves committed success on observer error", async () => {
  const { service, changed } = await fixture(); changed.mockImplementationOnce(() => { throw new Error("synthetic cancellation observer failure"); });
  const status = await service.connect("owner", request); expect(status.state).toBe("ready"); expect(changed).toHaveBeenCalledTimes(1);
  await service.connect("owner", request); expect(changed).toHaveBeenCalledTimes(1);
  await service.refresh("owner", { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "refresh-observe" });
  expect(changed).toHaveBeenCalledTimes(1);
  const disconnect = { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "disable-observe" };
  await service.disconnect("owner", disconnect); expect(changed).toHaveBeenCalledTimes(2);
  await service.disconnect("owner", disconnect); expect(changed).toHaveBeenCalledTimes(2); await service.shutdown();
});

it.each([200, 503])("bounds shutdown when HTTP %s discovery body cancellation does not settle", async status => {
  const cancelled = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { if (status === 200) controller.enqueue(new Uint8Array(262145)); },
    pull: () => new Promise<void>(() => {}), cancel: cancelled,
  });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(stream, { status }));
  const { service, store } = await fixture(fetcher);
  let settled = false;
  const connection = service.connect("owner", request).catch(error => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const stopped = service.shutdown().then(() => { settled = true; });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200, interval: 10 });
  expect(await connection).toBeInstanceOf(Error); await stopped;
  expect(cancelled).toHaveBeenCalled(); expect(stream.locked).toBe(false);
  expect(await store.read()).toMatchObject({ revision: 0, enabled: false });
});

it("withdraws uncertain Disconnect readiness, cancels consumers, and blocks all paid admission after transient proof failure", async () => {
  const { service, home, store, changed, fetcher } = await fixture();
  const status = await service.connect("owner", request), resolved = await service.resolve(selection(status), "owner", "interactive");
  const binding = { ownerId: "owner", kind: "managed_chat", requestClass: "interactive", ...resolved } as PiRuntimeBinding;
  const key = await readOwnerAnthropicKey(home), path = join(home, "system/ai-providers/matrix-anthropic-source.json");
  const read = boundedJson.readBoundedJsonFileWithIdentity, write = persistence.writeProviderJsonAtomic;
  let proofUnavailable = false;
  vi.spyOn(persistence, "writeProviderJsonAtomic").mockImplementation(async (target, value) => {
    if (target === path) { proofUnavailable = true; throw new Error("synthetic publication failure"); }
    return write(target, value);
  });
  vi.spyOn(boundedJson, "readBoundedJsonFileWithIdentity").mockImplementation(async (target, limit) => {
    if (target === path && proofUnavailable) { proofUnavailable = false; throw new Error("synthetic transient proof failure"); }
    return read(target, limit);
  });
  await expect(service.disconnect("owner", { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "uncertain-disable" })).rejects.toThrow();
  vi.restoreAllMocks();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(await service.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
  expect(await service.revalidate(binding, new AbortController().signal)).toBe(false);
  await expect(service.credential(binding, new AbortController().signal)).rejects.toThrow();
  await expect(service.resolve(selection(status), "owner", "interactive")).rejects.toThrow();
  await expect(service.connect("owner", request)).rejects.toThrow();
  await expect(service.refresh("owner", { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "uncertain-refresh" })).rejects.toThrow();
  const restarted = createMatrixAnthropicConnectionService({ homePath: home, ownerId: "owner", sourceStore: store, supports: { rootChat: true, recipeBots: true }, fetch: fetcher });
  expect(await restarted.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(await readOwnerAnthropicKey(home)).toEqual(key);
  await restarted.shutdown(); await service.shutdown();
});
it("resumes qualification only after a known writer releases its exact admission", async () => {
  const { service, home } = await fixture(), status = await service.connect("owner", request);
  const lease = await createNativeProviderWriterLease(home).acquire("claude");
  try {
    expect(await service.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
    await expect(service.resolve(selection(status), "owner", "interactive")).rejects.toThrow();
  } finally { await lease(); }
  expect(await service.observe("owner")).toEqual(status);
  await service.shutdown();
});
it("keeps prior qualification when failed Disconnect proves no publication and permits safe retry", async () => {
  const { service, home, changed } = await fixture(), status = await service.connect("owner", request);
  const path = join(home, "system/ai-providers/matrix-anthropic-source.json"), write = persistence.writeProviderJsonAtomic;
  vi.spyOn(persistence, "writeProviderJsonAtomic").mockImplementation(async (target, value) => {
    if (target === path) throw new Error("synthetic pre-publication failure");
    return write(target, value);
  });
  const disconnect = { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "proven-disable" };
  await expect(service.disconnect("owner", disconnect)).rejects.toMatchObject({ code: "unavailable" });
  vi.restoreAllMocks();
  expect(await service.observe("owner")).toEqual(status); expect(changed).toHaveBeenCalledTimes(1);
  expect(await service.disconnect("owner", disconnect)).toMatchObject({ state: "disconnected", revision: 2 });
  expect(changed).toHaveBeenCalledTimes(2); await service.shutdown();
});

it("rejects observation when a writer is admitted between source and canonical key reads", async () => {
  const { service, home } = await fixture(), status = await service.connect("owner", request);
  const path = join(home, "system/ai-providers/anthropic-key.json"), read = boundedJson.readBoundedJsonFileWithIdentity;
  let release: (() => Promise<void>) | undefined;
  try {
    vi.spyOn(boundedJson, "readBoundedJsonFileWithIdentity").mockImplementation(async (target, limit) => {
      const document = await read(target, limit);
      if (target === path && !release) release = await createNativeProviderWriterLease(home).acquire("claude");
      return document;
    });
    expect(await service.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
  } finally { vi.restoreAllMocks(); await release?.(); }
  expect(await service.observe("owner")).toEqual(status); await service.shutdown();
});

it("cancels consumers when new Disconnect published successfully but durable lease release fails", async () => {
  const { service, home, guard, changed } = await fixture(), status = await service.connect("owner", request);
  const writers = join(dirname(home), ".matrix-private", basename(home), "native-writers"), run = guard.run.bind(guard);
  vi.spyOn(guard, "run").mockImplementation((profile, admission, operation) => run(profile, admission, async () => {
    const result = await operation(); await chmod(writers, 0o500); return result;
  }));
  try {
    const failure = await service.disconnect("owner", { expectedRevision: 1, expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: "release-failed-disable" }).catch(error => error);
    expect(JSON.parse(await readFile(join(home, "system/ai-providers/matrix-anthropic-source.json"), "utf8")).state).toMatchObject({ enabled: false, revision: 2 });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({ name: "MatrixAnthropicPublicationUncertainError" });
    expect(await service.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
    await chmod(writers, 0o700);
    expect(await service.observe("owner")).toMatchObject({ state: "unavailable", models: [] });
    expect(JSON.parse(await readFile(join(writers, "claude.json"), "utf8")).profile).toBe("claude");
  } finally { await chmod(writers, 0o700); await service.shutdown(); }
});
it("does not classify replayed old Disconnect release failure as new publication or cancel newer catalog", async () => {
  const { service, home, guard, changed } = await fixture(), first = await service.connect("owner", request);
  const disconnect = { expectedRevision: 1, expectedCredentialGeneration: first.credentialGeneration, idempotencyKey: "old-disable-release" };
  const disabled = await service.disconnect("owner", disconnect);
  const newer = await service.connect("owner", { ...request, expectedRevision: disabled.revision, expectedCredentialGeneration: disabled.credentialGeneration, idempotencyKey: "newer-connect-release" });
  const writers = join(dirname(home), ".matrix-private", basename(home), "native-writers"), run = guard.run.bind(guard);
  vi.spyOn(guard, "run").mockImplementation((profile, admission, operation) => run(profile, admission, async () => {
    const result = await operation(); await chmod(writers, 0o500); return result;
  }));
  try {
    await expect(service.disconnect("owner", disconnect)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(JSON.parse(await readFile(join(home, "system/ai-providers/matrix-anthropic-source.json"), "utf8")).state).toMatchObject({ enabled: true, revision: newer.revision });
    expect(changed).toHaveBeenCalledTimes(3);
  } finally { await chmod(writers, 0o700); await service.shutdown(); }
});
