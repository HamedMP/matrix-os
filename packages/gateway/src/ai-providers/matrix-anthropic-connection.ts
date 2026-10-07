import { z } from "zod/v4";
import { BotModelRouteSchema, MatrixAnthropicConnectionSchema, MatrixAnthropicConnectSchema, MatrixAnthropicDisconnectSchema, MatrixAnthropicRefreshSchema,
  MATRIX_PI_ANTHROPIC_API_INSTANCE_ID, MATRIX_ANTHROPIC_API_INSTANCE_ID, matrixAnthropicSelectionBinding,
  type MatrixAnthropicConnection, type MatrixAnthropicConnect, type MatrixAnthropicDisconnect, type MatrixAnthropicRefresh } from "@matrix-os/contracts";
import type { MatrixAnthropicAuthority } from "../bots/matrix-anthropic-api.js";
import type { PiRuntimeBinding } from "../bots/runtime-registry.js";
import { BotRouteError, type ResolvedBotRoute } from "../bots/route-resolver.js";
import { readOwnerAnthropicKey } from "./owner-anthropic-key.js";
import { MatrixAnthropicPublicationUncertainError, type createMatrixAnthropicSourceStore } from "./matrix-anthropic-source.js";

const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const TokenLimit = z.number().int().positive().max(10_000_000);
const Model = z.object({ type: z.literal("model"), id: ref, display_name: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  max_input_tokens: TokenLimit, max_tokens: TokenLimit,
  capabilities: z.object({ image_input: z.object({ supported: z.boolean() }).optional() }).nullable().optional(),
});
const Page = z.object({ data: z.array(z.unknown()).max(100), has_more: z.boolean(), last_id: ref.nullable() });
type QualifiedModel = z.infer<typeof Model>;
function runtimeRoute(model: QualifiedModel) {
  return BotModelRouteSchema.safeParse({ api: "anthropic-messages", modelId: model.id,
    input: model.capabilities?.image_input?.supported === true ? ["text", "image"] : ["text"],
    contextWindow: Math.min(model.max_input_tokens, 2_000_000), maxOutputTokens: Math.min(model.max_tokens, 8192) });
}
type Store = ReturnType<typeof createMatrixAnthropicSourceStore>;
export class MatrixAnthropicConnectionError extends Error {
  constructor(readonly code: "forbidden" | "rejected" | "conflict" | "unavailable") { super(code); this.name = "MatrixAnthropicConnectionError"; }
}
export interface MatrixAnthropicConnectionService extends MatrixAnthropicAuthority {
  connect(ownerId: string, input: MatrixAnthropicConnect): Promise<MatrixAnthropicConnection>;
  refresh(ownerId: string, input: MatrixAnthropicRefresh): Promise<MatrixAnthropicConnection>;
  disconnect(ownerId: string, input: MatrixAnthropicDisconnect): Promise<MatrixAnthropicConnection>;
  shutdown(): Promise<void>;
}

/** Fixed provider endpoint; one bounded catalog slot and one serialized discovery flight per owner runtime. */
export function createMatrixAnthropicConnectionService(options: {
  homePath: string; ownerId: string; sourceStore: Store; supports: { rootChat: boolean; recipeBots: boolean };
  readOnly?: boolean; onSourceChanged?: () => void; fetch?: typeof fetch; now?: () => number; ttlMs?: number;
}): MatrixAnthropicConnectionService {
  if (!options.homePath || !options.ownerId || !options.sourceStore || !options.supports) throw new Error("Matrix connection dependencies required");
  const now = options.now ?? Date.now, fetcher = options.fetch ?? fetch;
  const ttl = Math.max(1000, Math.min(options.ttlMs ?? 5 * 60_000, 10 * 60_000));
  const shutdown = new AbortController(); let closed = false, queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let catalog: { generation: string; revision: number; checkedAt: number; models: QualifiedModel[] } | null = null;
  // Refresh has no persistent effect. Bounded retry receipts expire with qualification and drain on shutdown.
  const refreshReceipts: Array<{ key: string; payload: string; expires: number }> = [];
  const authorize = (owner: string) => {
    if (owner !== options.ownerId) throw new MatrixAnthropicConnectionError("forbidden");
    if (closed) throw new MatrixAnthropicConnectionError("unavailable");
  };
  const notifyChanged = () => {
    try { options.onSourceChanged?.(); }
    catch (error) { console.warn("[matrix-connection] Source observer failed:", error instanceof Error ? error.name : "UnknownError"); }
  };
  const writable = () => { if (options.readOnly || !options.supports.rootChat && !options.supports.recipeBots) throw new MatrixAnthropicConnectionError("unavailable"); };
  async function current() {
    const source = await options.sourceStore.read(), key = await readOwnerAnthropicKey(options.homePath);
    // Key custody can change after the metadata read; recheck the same durable fence.
    await options.sourceStore.assertAvailable();
    if (key.state === "invalid" || key.state === "unavailable") throw new MatrixAnthropicConnectionError("unavailable");
    return { source, key, generation: key.credentialGeneration ?? null };
  }
  async function observe(owner: string): Promise<MatrixAnthropicConnection> {
    authorize(owner);
    let source = { version: 1 as const, revision: 0, enabled: false, credentialGeneration: null as string | null }, generation: string | null = null;
    let state: MatrixAnthropicConnection["state"] = "unavailable";
    try {
      const captured = await current(); source = captured.source; generation = captured.generation;
      state = !source.enabled ? "disconnected" : !captured.key.key || source.credentialGeneration !== generation ? "auth_required"
        : !catalog || catalog.generation !== generation || catalog.revision !== source.revision || now() >= catalog.checkedAt + ttl ? "refresh_required" : "ready";
    } catch (error) { console.warn("[matrix-connection] Observation unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    if (options.readOnly) state = "read_only";
    else if (!options.supports.rootChat && !options.supports.recipeBots) state = "unsupported";
    const usable = state === "ready" ? catalog : null;
    return MatrixAnthropicConnectionSchema.parse({ connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
      revision: source.revision, enabled: source.enabled, credentialGeneration: generation, sourceCredentialGeneration: source.credentialGeneration,
      state, models: usable?.models.map(model => ({ id: model.id, displayName: model.display_name })) ?? [],
      actions: state === "read_only" || state === "unsupported" ? [] : ["connect", ...(source.enabled ? ["refresh", "disconnect"] : [])],
      checkedAt: usable ? new Date(usable.checkedAt).toISOString() : null, staleAfter: usable ? new Date(usable.checkedAt + ttl).toISOString() : null,
      supports: state === "read_only" || state === "unsupported" ? { rootChat: false, recipeBots: false } : options.supports });
  }
  async function enqueue<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    authorize(owner); writable(); if (queued >= 8) throw new MatrixAnthropicConnectionError("unavailable"); queued++;
    const task = tail.then(async () => { authorize(owner); return operation(); });
    tail = task.then(() => undefined, () => undefined);
    try { return await task; } finally { queued--; }
  }
  async function readPage(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new MatrixAnthropicConnectionError("unavailable");
    if (Number(response.headers.get("content-length")) > 256 * 1024) {
      void response.body.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError"));
      throw new MatrixAnthropicConnectionError("unavailable");
    }
    const reader = response.body.getReader(); const bytes = new Uint8Array(256 * 1024); let size = 0;
    const abort = () => { void reader.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
        if (size + part.value.byteLength > bytes.length) throw new MatrixAnthropicConnectionError("unavailable"); bytes.set(part.value, size); size += part.value.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } finally {
      signal.removeEventListener("abort", abort);
      // Upstream cancellation may itself never settle. It must not retain our queue or reader lock.
      abort(); reader.releaseLock();
    }
  }
  async function discover(apiKey: string): Promise<QualifiedModel[]> {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]); const models: QualifiedModel[] = [];
    let after: string | null = null;
    try {
      for (let page = 0; page < 4; page++) {
        const url = new URL("https://api.anthropic.com/v1/models"); url.searchParams.set("limit", "100"); if (after) url.searchParams.set("after_id", after);
        const response = await fetcher(url, { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, redirect: "error", signal });
        if (!response.ok) {
          void response.body?.cancel().catch(error => console.warn("[matrix-connection] Discovery drain failed:", error instanceof Error ? error.name : "UnknownError"));
          throw new MatrixAnthropicConnectionError(response.status === 401 || response.status === 403 ? "rejected" : "unavailable");
        }
        const parsed = Page.parse(await readPage(response, signal));
        for (const item of parsed.data) { const model = Model.safeParse(item); if (!model.success || !runtimeRoute(model.data).success) continue;
          if (models.some(candidate => candidate.id === model.data.id)) throw new MatrixAnthropicConnectionError("unavailable"); models.push(model.data);
          if (models.length > 256) throw new MatrixAnthropicConnectionError("unavailable"); }
        if (!parsed.has_more) { if (!models.length) throw new MatrixAnthropicConnectionError("unavailable"); return models; }
        if (!parsed.last_id || parsed.last_id === after) throw new MatrixAnthropicConnectionError("unavailable"); after = parsed.last_id;
      }
      throw new MatrixAnthropicConnectionError("unavailable");
    } catch (error) { if (error instanceof MatrixAnthropicConnectionError) throw error;
      console.warn("[matrix-connection] Discovery unavailable:", error instanceof Error ? error.name : "UnknownError"); throw new MatrixAnthropicConnectionError("unavailable"); }
  }
  const assertCAS = (captured: Awaited<ReturnType<typeof current>>, input: MatrixAnthropicRefresh) => {
    if (captured.source.revision !== input.expectedRevision || captured.generation !== input.expectedCredentialGeneration) throw new MatrixAnthropicConnectionError("conflict");
  };
  async function valid(binding: PiRuntimeBinding, signal: AbortSignal) {
    if (signal.aborted || closed || binding.ownerId !== options.ownerId || !binding.anthropicApi || binding.subscription
      || binding.accessSourceId !== "owner_anthropic_key" || binding.route.api !== "anthropic-messages"
      || ("kind" in binding ? !options.supports.rootChat : !options.supports.recipeBots) || options.readOnly) return null;
    const status = await observe(binding.ownerId);
    if (signal.aborted || status.state !== "ready" || status.revision !== binding.anthropicApi.connectionRevision
      || status.credentialGeneration !== binding.anthropicApi.credentialGeneration || !status.models.some(model => model.id === binding.route.modelId)) return null;
    const captured = await current();
    return !signal.aborted && captured.source.enabled && captured.source.revision === binding.anthropicApi.connectionRevision
      && captured.source.credentialGeneration === binding.anthropicApi.credentialGeneration && captured.generation === binding.anthropicApi.credentialGeneration ? captured.key.key ?? null : null;
  }
  return {
    observe,
    connect: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixAnthropicConnectSchema.safeParse(input); if (!parsed.success) throw new MatrixAnthropicConnectionError("rejected");
      if (await options.sourceStore.replayConnection(parsed.data)) return observe(owner);
      assertCAS(await current(), parsed.data); const models = await discover(parsed.data.apiKey); authorize(owner);
      const result = await options.sourceStore.commitConnection(parsed.data);
      if (!result.replayed) { catalog = { generation: result.state.credentialGeneration!, revision: result.state.revision, checkedAt: now(), models }; notifyChanged(); }
      return observe(owner);
    }),
    refresh: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixAnthropicRefreshSchema.safeParse(input); if (!parsed.success) throw new MatrixAnthropicConnectionError("rejected");
      const payload = JSON.stringify([parsed.data.expectedRevision, parsed.data.expectedCredentialGeneration]);
      while (refreshReceipts.length && refreshReceipts[0]!.expires <= now()) refreshReceipts.shift();
      const receipt = refreshReceipts.find(item => item.key === parsed.data.idempotencyKey);
      if (receipt) { if (receipt.payload !== payload) throw new MatrixAnthropicConnectionError("conflict"); return observe(owner); }
      const captured = await current(); assertCAS(captured, parsed.data);
      if (!captured.source.enabled || captured.source.credentialGeneration !== captured.generation || !captured.key.key) throw new MatrixAnthropicConnectionError("rejected");
      let models: QualifiedModel[];
      try { models = await discover(captured.key.key); }
      catch (error) { if (catalog?.generation === captured.generation && catalog.revision === captured.source.revision) catalog = null; throw error; }
      authorize(owner); const latest = await current(); assertCAS(latest, parsed.data);
      if (!latest.source.enabled || latest.source.credentialGeneration !== captured.source.credentialGeneration) throw new MatrixAnthropicConnectionError("conflict");
      catalog = { generation: captured.generation!, revision: captured.source.revision, checkedAt: now(), models };
      refreshReceipts.push({ key: parsed.data.idempotencyKey, payload, expires: now() + ttl }); if (refreshReceipts.length > 64) refreshReceipts.shift(); return observe(owner);
    }),
    disconnect: (owner, input) => enqueue(owner, async () => {
      const parsed = MatrixAnthropicDisconnectSchema.safeParse(input); if (!parsed.success) throw new MatrixAnthropicConnectionError("rejected");
      try {
        const result = await options.sourceStore.disconnect(parsed.data);
        if (!result.replayed) { catalog = null; notifyChanged(); }
        return observe(owner);
      } catch (error) {
        if (error instanceof MatrixAnthropicPublicationUncertainError) {
          // Unknown publication is enough to withdraw qualification and cancel paid consumers.
          // Conflicts, proven non-publication and old receipt replays preserve newer catalogs.
          catalog = null; notifyChanged();
        }
        throw error;
      }
    }),
    async resolve(selection, owner, requestClass): Promise<ResolvedBotRoute> {
      authorize(owner); const bound = matrixAnthropicSelectionBinding(selection.options);
      const chat = selection.instanceId === MATRIX_PI_ANTHROPIC_API_INSTANCE_ID, recipe = selection.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID;
      if (!bound || !chat && !recipe || chat && (!options.supports.rootChat || requestClass !== "interactive") || recipe && !options.supports.recipeBots) throw new BotRouteError("model_unavailable");
      const status = await observe(owner), model = catalog?.models.find(candidate => candidate.id === selection.model);
      if (status.state !== "ready" || status.revision !== bound.connectionRevision || status.credentialGeneration !== bound.credentialGeneration || !model) throw new BotRouteError("model_unavailable");
      const route = runtimeRoute(model); if (!route.success) throw new BotRouteError("model_unavailable");
      return { accessSourceId: "owner_anthropic_key", anthropicApi: bound, route: route.data };
    },
    async revalidate(binding, signal) { try { return Boolean(await valid(binding, signal)); } catch (error) { console.warn("[matrix-connection] Binding unavailable:", error instanceof Error ? error.name : "UnknownError"); return false; } },
    async credential(binding, signal) { const key = await valid(binding, signal); if (!key) throw new BotRouteError("model_unavailable"); return key; },
    async shutdown() { closed = true; shutdown.abort(); await tail; catalog = null; refreshReceipts.splice(0); },
  };
}
