import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BotModelRouteSchema, MatrixOpenAiConnectionSchema, MatrixOpenAiConnectSchema, MatrixOpenAiDisconnectSchema, MatrixOpenAiRefreshSchema,
  MATRIX_PI_OPENAI_API_INSTANCE_ID, MATRIX_OPENAI_API_INSTANCE_ID, matrixOpenAiSelectionBinding,
  type MatrixOpenAiConnection, type MatrixOpenAiConnect, type MatrixOpenAiDisconnect, type MatrixOpenAiRefresh } from "@matrix-os/contracts";
import type { MatrixOpenAiAuthority } from "../bots/matrix-openai-api.js";
import type { PiRuntimeBinding } from "../bots/runtime-registry.js";
import { BotRouteError, type ResolvedBotRoute } from "../bots/route-resolver.js";
import { readOwnerOpenAiKey } from "./owner-openai-key.js";
import { MatrixOpenAiPublicationUncertainError, type createMatrixOpenAiSourceStore } from "./matrix-openai-source.js";

const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Model = z.object({ object: z.literal("model"), id: ref });
const Page = z.object({ object: z.literal("list"), data: z.array(z.unknown()).max(2048) });
type QualifiedModel = z.infer<typeof Model>;
// Conservative local adapter capability envelope, intersected with authenticated
// model discovery. Unknown/audio/image-only endpoints are never inferred usable.
function supportedModel(id: string): boolean {
  return /^(gpt-4[.]1(?:-mini|-nano)?|gpt-4o(?:-mini)?|gpt-5(?:[.]\d+)?(?:-mini|-nano)?|o3(?:-mini)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
}
function runtimeRoute(model: QualifiedModel, api: "openai-completions" | "openai-responses") {
  return BotModelRouteSchema.safeParse({ api, modelId: model.id, input: ["text"], contextWindow: 128000, maxOutputTokens: 8192 });
}
type Store = ReturnType<typeof createMatrixOpenAiSourceStore>;
export class MatrixOpenAiConnectionError extends Error {
  constructor(readonly code: "forbidden" | "rejected" | "conflict" | "unavailable") { super(code); this.name = "MatrixOpenAiConnectionError"; }
}
export interface MatrixOpenAiConnectionService extends MatrixOpenAiAuthority {
  connect(ownerId: string, input: MatrixOpenAiConnect): Promise<MatrixOpenAiConnection>;
  refresh(ownerId: string, input: MatrixOpenAiRefresh): Promise<MatrixOpenAiConnection>;
  disconnect(ownerId: string, input: MatrixOpenAiDisconnect): Promise<MatrixOpenAiConnection>;
  shutdown(): Promise<void>;
}

/** Fixed provider endpoint; one bounded catalog slot and one serialized discovery flight per owner runtime. */
export function createMatrixOpenAiConnectionService(options: {
  homePath: string; ownerId: string; sourceStore: Store; supports: { rootChat: boolean; recipeBots: boolean };
  readOnly?: boolean; onSourceChanged?: () => void; fetch?: typeof fetch; now?: () => number; ttlMs?: number;
}): MatrixOpenAiConnectionService {
  if (!options.homePath || !options.ownerId || !options.sourceStore || !options.supports) throw new Error("Matrix connection dependencies required");
  const now = options.now ?? Date.now, fetcher = options.fetch ?? fetch;
  const ttl = Math.max(1000, Math.min(options.ttlMs ?? 5 * 60_000, 10 * 60_000));
  const shutdown = new AbortController(); let closed = false, queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let catalog: { credentialFingerprint: string; generation: string; revision: number; checkedAt: number; models: QualifiedModel[] } | null = null;
  // Refresh has no persistent effect. Bounded retry receipts expire with qualification and drain on shutdown.
  const refreshReceipts: Array<{ key: string; payload: string; expires: number }> = [];
  const authorize = (owner: string) => {
    if (owner !== options.ownerId) throw new MatrixOpenAiConnectionError("forbidden");
    if (closed) throw new MatrixOpenAiConnectionError("unavailable");
  };
  const notifyChanged = () => {
    try { options.onSourceChanged?.(); }
    catch (error) { console.warn("[matrix-connection] Source observer failed:", error instanceof Error ? error.name : "UnknownError"); }
  };
  const writable = () => { if (options.readOnly || !options.supports.rootChat && !options.supports.recipeBots) throw new MatrixOpenAiConnectionError("unavailable"); };
  async function current() {
    const source = await options.sourceStore.read(), key = await readOwnerOpenAiKey(options.homePath);
    // Key custody can change after the metadata read; recheck the same durable fence.
    await options.sourceStore.assertAvailable();
    if (key.state === "invalid" || key.state === "unavailable") throw new MatrixOpenAiConnectionError("unavailable");
    return { source, key, generation: key.credentialGeneration ?? null, credentialFingerprint: key.key ? createHash("sha256").update(key.key).digest("hex") : null };
  }
  async function observe(owner: string): Promise<MatrixOpenAiConnection> {
    authorize(owner);
    let source = { version: 1 as const, revision: 0, enabled: false, credentialGeneration: null as string | null }, generation: string | null = null;
    let state: MatrixOpenAiConnection["state"] = "unavailable";
    try {
      const captured = await current(); source = captured.source; generation = captured.generation;
      state = !source.enabled ? "disconnected" : !captured.key.key || source.credentialGeneration !== generation || catalog && catalog.credentialFingerprint !== captured.credentialFingerprint ? "auth_required"
        : !catalog || catalog.generation !== generation || catalog.revision !== source.revision || now() >= catalog.checkedAt + ttl ? "refresh_required" : "ready";
    } catch (error) { console.warn("[matrix-connection] Observation unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    if (options.readOnly) state = "read_only";
    else if (!options.supports.rootChat && !options.supports.recipeBots) state = "unsupported";
    const usable = state === "ready" ? catalog : null;
    return MatrixOpenAiConnectionSchema.parse({ connectionId: "matrix_openai_api", providerId: "openai", executionKind: "direct_pi", billingKind: "api_key",
      revision: source.revision, enabled: source.enabled, credentialGeneration: generation, sourceCredentialGeneration: source.credentialGeneration,
      state, models: usable?.models.map(model => ({ id: model.id, displayName: model.id, input: ["text"] })) ?? [],
      actions: state === "read_only" || state === "unsupported" ? [] : ["connect", ...(source.enabled ? ["refresh", "disconnect"] : [])],
      checkedAt: usable ? new Date(usable.checkedAt).toISOString() : null, staleAfter: usable ? new Date(usable.checkedAt + ttl).toISOString() : null,
      supports: state === "read_only" || state === "unsupported" ? { rootChat: false, recipeBots: false } : options.supports });
  }
  async function enqueue<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    authorize(owner); writable(); if (queued >= 8) throw new MatrixOpenAiConnectionError("unavailable"); queued++;
    const task = tail.then(async () => { authorize(owner); return operation(); });
    tail = task.then(() => undefined, () => undefined);
    try { return await task; } finally { queued--; }
  }
  async function readPage(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new MatrixOpenAiConnectionError("unavailable");
    if (Number(response.headers.get("content-length")) > 256 * 1024) {
      void response.body.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError"));
      throw new MatrixOpenAiConnectionError("unavailable");
    }
    const reader = response.body.getReader(); const bytes = new Uint8Array(256 * 1024); let size = 0;
    const abort = () => { void reader.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
        if (size + part.value.byteLength > bytes.length) throw new MatrixOpenAiConnectionError("unavailable"); bytes.set(part.value, size); size += part.value.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } finally {
      signal.removeEventListener("abort", abort);
      // Upstream cancellation may itself never settle. It must not retain our queue or reader lock.
      abort(); reader.releaseLock();
    }
  }
  async function discover(apiKey: string): Promise<QualifiedModel[]> {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]); const models: QualifiedModel[] = [];
    try {
      const response = await fetcher("https://api.openai.com/v1/models", { method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal });
      if (!response.ok) {
        void response.body?.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError"));
        throw new MatrixOpenAiConnectionError(response.status === 401 || response.status === 403 ? "rejected" : "unavailable");
      }
      const parsed = Page.parse(await readPage(response, signal));
      for (const item of parsed.data) {
        const model = Model.safeParse(item);
        if (!model.success || !supportedModel(model.data.id)) continue;
        if (models.some(candidate => candidate.id === model.data.id) || models.length >= 256) throw new MatrixOpenAiConnectionError("unavailable");
        models.push(model.data);
      }
      if (!models.length) throw new MatrixOpenAiConnectionError("rejected");
      return models;
    } catch (error) { if (error instanceof MatrixOpenAiConnectionError) throw error;
      console.warn("[matrix-connection] Discovery unavailable:", error instanceof Error ? error.name : "UnknownError"); throw new MatrixOpenAiConnectionError("unavailable"); }
  }

  const assertCAS = (captured: Awaited<ReturnType<typeof current>>, input: MatrixOpenAiRefresh) => {
    if (captured.source.revision !== input.expectedRevision || captured.generation !== input.expectedCredentialGeneration) throw new MatrixOpenAiConnectionError("conflict");
  };
  async function valid(binding: PiRuntimeBinding, signal: AbortSignal) {
    if (signal.aborted || closed || binding.ownerId !== options.ownerId || !binding.openaiApi || binding.subscription
      || binding.accessSourceId !== "owner_openai_key" || !["openai-completions", "openai-responses"].includes(binding.route.api)
      || ("kind" in binding ? !options.supports.rootChat : !options.supports.recipeBots) || options.readOnly) return null;
    const status = await observe(binding.ownerId);
    if (signal.aborted || status.state !== "ready" || status.revision !== binding.openaiApi.connectionRevision
      || status.credentialGeneration !== binding.openaiApi.credentialGeneration || !status.models.some(model => model.id === binding.route.modelId)) return null;
    const qualified = catalog;
    const captured = await current();
    return !signal.aborted && qualified !== null && catalog === qualified && captured.credentialFingerprint === qualified.credentialFingerprint && captured.source.enabled && captured.source.revision === binding.openaiApi.connectionRevision
      && captured.source.credentialGeneration === binding.openaiApi.credentialGeneration && captured.generation === binding.openaiApi.credentialGeneration ? captured.key.key ?? null : null;
  }
  return {
    observe,
    connect: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixOpenAiConnectSchema.safeParse(input); if (!parsed.success) throw new MatrixOpenAiConnectionError("rejected");
      if (await options.sourceStore.replayConnection(parsed.data)) return observe(owner);
      assertCAS(await current(), parsed.data); const models = await discover(parsed.data.apiKey); authorize(owner);
      const result = await options.sourceStore.commitConnection(parsed.data);
      if (!result.replayed) { catalog = { credentialFingerprint: createHash("sha256").update(parsed.data.apiKey).digest("hex"), generation: result.state.credentialGeneration!, revision: result.state.revision, checkedAt: now(), models }; notifyChanged(); }
      return observe(owner);
    }),
    refresh: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixOpenAiRefreshSchema.safeParse(input); if (!parsed.success) throw new MatrixOpenAiConnectionError("rejected");
      const payload = JSON.stringify([parsed.data.expectedRevision, parsed.data.expectedCredentialGeneration]);
      while (refreshReceipts.length && refreshReceipts[0]!.expires <= now()) refreshReceipts.shift();
      const receipt = refreshReceipts.find(item => item.key === parsed.data.idempotencyKey);
      if (receipt) { if (receipt.payload !== payload) throw new MatrixOpenAiConnectionError("conflict"); return observe(owner); }
      const captured = await current(); assertCAS(captured, parsed.data);
      if (!captured.source.enabled || captured.source.credentialGeneration !== captured.generation || !captured.key.key) throw new MatrixOpenAiConnectionError("rejected");
      let models: QualifiedModel[];
      try { models = await discover(captured.key.key); }
      catch (error) { if (catalog?.generation === captured.generation && catalog.revision === captured.source.revision) catalog = null; throw error; }
      authorize(owner); const latest = await current(); assertCAS(latest, parsed.data);
      if (!latest.source.enabled || latest.source.credentialGeneration !== captured.source.credentialGeneration || latest.credentialFingerprint !== captured.credentialFingerprint) throw new MatrixOpenAiConnectionError("conflict");
      catalog = { credentialFingerprint: captured.credentialFingerprint!, generation: captured.generation!, revision: captured.source.revision, checkedAt: now(), models };
      refreshReceipts.push({ key: parsed.data.idempotencyKey, payload, expires: now() + ttl }); if (refreshReceipts.length > 64) refreshReceipts.shift(); return observe(owner);
    }),
    disconnect: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixOpenAiDisconnectSchema.safeParse(input); if (!parsed.success) throw new MatrixOpenAiConnectionError("rejected");
      try {
        const result = await options.sourceStore.disconnect(parsed.data);
        if (!result.replayed) { catalog = null; notifyChanged(); }
        return observe(owner);
      } catch (error) {
        if (error instanceof MatrixOpenAiPublicationUncertainError) {
          // Unknown publication is enough to withdraw qualification and cancel paid consumers.
          // Conflicts, proven non-publication and old receipt replays preserve newer catalogs.
          catalog = null; notifyChanged();
        }
        throw error;
      }
    }),
    async resolve(selection, owner, requestClass): Promise<ResolvedBotRoute> {
      authorize(owner); const bound = matrixOpenAiSelectionBinding(selection.options);
      const chat = selection.instanceId === MATRIX_PI_OPENAI_API_INSTANCE_ID, recipe = selection.instanceId === MATRIX_OPENAI_API_INSTANCE_ID;
      if (!bound || !chat && !recipe || chat && (!options.supports.rootChat || requestClass !== "interactive") || recipe && !options.supports.recipeBots) throw new BotRouteError("model_unavailable");
      const status = await observe(owner), model = catalog?.models.find(candidate => candidate.id === selection.model);
      if (status.state !== "ready" || status.revision !== bound.connectionRevision || status.credentialGeneration !== bound.credentialGeneration || !model) throw new BotRouteError("model_unavailable");
      const route = runtimeRoute(model, bound.api); if (!route.success) throw new BotRouteError("model_unavailable");
      const { api: _api, ...source } = bound;
      return { accessSourceId: "owner_openai_key", openaiApi: source, route: route.data };
    },
    async revalidate(binding, signal) { try { return Boolean(await valid(binding, signal)); } catch (error) { console.warn("[matrix-connection] Binding unavailable:", error instanceof Error ? error.name : "UnknownError"); return false; } },
    async credential(binding, signal) { const key = await valid(binding, signal); if (!key) throw new BotRouteError("model_unavailable"); return key; },
    async shutdown() { closed = true; shutdown.abort(); await tail; catalog = null; refreshReceipts.splice(0); },
  };
}
