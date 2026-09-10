import type { CodingModelCatalogProjection } from "./provider-catalog.js";
import { CanonicalChatModelSelectionSchema, CanonicalModelDescriptorSchema, type AgentProviderSummary } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { z } from "zod/v4";

// Maintained fallback, not proof of account entitlement. Native execution remains
// authoritative and reports unsupported models without silently substituting.
// https://support.claude.com/en/articles/11940350-claude-code-model-configuration
export function claudeFallbackCatalog(): CodingModelCatalogProjection {
  return {
    models: [
      ["default", "Claude default"],
      ["opus", "Claude Opus"],
      ["sonnet", "Claude Sonnet"],
    ].map(([id, displayName]) => ({
      id: id!, displayName: displayName!, capabilities: ["reasoning", "tools", "vision"],
      supportsVision: true, supportsToolUse: true,
    })),
    defaultModel: "default",
    options: [{
      id: "effort", label: "Reasoning", kind: "enum",
      values: ["low", "medium", "high", "max"].map((value) => ({
        value, label: value.charAt(0).toUpperCase() + value.slice(1),
      })),
      defaultValue: "low", placement: "composer",
    }],
  };
}

const ModelInfoSchema = z.object({
  value: z.string().min(1).max(160),
  resolvedModel: z.string().min(1).max(160).optional(),
  displayName: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/)
    .pipe(CanonicalModelDescriptorSchema.shape.displayName),
});

function projectModels(value: unknown): CodingModelCatalogProjection {
  const rows = z.array(ModelInfoSchema).min(1).max(64).parse(value);
  const catalog = claudeFallbackCatalog();
  // Keep legacy aliases/default stable, without claiming that a documented
  // model absent from this runtime's inventory is available on this account.
  for (const row of rows) {
    if (catalog.models.length === 64) break;
    const id = CanonicalChatModelSelectionSchema.shape.model.safeParse(row.value);
    const resolved = CanonicalChatModelSelectionSchema.shape.model.safeParse(row.resolvedModel);
    const model = id.success ? id.data : resolved.success ? resolved.data : null;
    if (!model || catalog.models.some((entry) => entry.id === model)) continue;
    catalog.models.push({
      id: model,
      // A resolved ID is a separate base-model choice, not an advertised [1m]
      // option. Never strip qualifiers or rewrite an existing selection.
      displayName: id.success ? row.displayName : model,
      capabilities: ["reasoning", "tools", "vision"], supportsVision: true, supportsToolUse: true,
    });
  }
  return catalog;
}

type Discovery = (signal: AbortSignal) => Promise<unknown>;
type DiscoveryContext = { key: string; discover: Discovery; retainOnRefresh?: boolean; maxAgeMs?: number };
type CachedInventory = {
  contextKey: string;
  value: CodingModelCatalogProjection | null;
  expiresAt: number;
  staleAt: number;
  retainOnRefresh: boolean;
};

export function createClaudeModelCatalogSource(options: {
  discover?: Discovery;
  resolveContext?: (signal: AbortSignal) => Promise<DiscoveryContext>;
  cacheTtlMs?: number;
  timeoutMs?: number;
}) {
  if (!options.discover && !options.resolveContext) throw new Error("Claude inventory source is required");
  const ttl = Math.max(1, Math.min(options.cacheTtlMs ?? 60_000, 300_000));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 30_000));
  const cached = new Map<string, CachedInventory>();
  // Each map is capped at 32 owner contexts; settled reads leave pending and
  // insertion-order eviction bounds retained metadata, including failed reads.
  const pending = new Map<string, { request: Promise<CodingModelCatalogProjection | null>; invalidated: boolean }>();
  const source = async (provider: AgentProviderSummary, principal: RequestPrincipal): Promise<CodingModelCatalogProjection | null> => {
    if ((provider.kind !== "claude" && provider.id !== "claude")
      || provider.availability !== "available") return null;
    const existing = pending.get(principal.userId);
    if (existing) {
      await existing.request;
      // Resolve identity again before sharing a completed read: credentials may
      // have changed while the caller was waiting for another request.
      return source(provider, principal);
    }
    if (pending.size >= 32) return null;
    const state = { request: Promise.resolve<CodingModelCatalogProjection | null>(null), invalidated: false };
    const save = (entry: CachedInventory) => {
      if (state.invalidated && !entry.retainOnRefresh) return;
      if (state.invalidated) entry.expiresAt = 0;
      if (cached.size >= 32 && !cached.has(principal.userId)) cached.delete(cached.keys().next().value!);
      cached.set(principal.userId, entry);
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Claude model discovery timed out"));
      }, timeoutMs);
    });
    let contextKey: string | undefined;
    let hit: CachedInventory | undefined;
    const load = async () => {
      const context = options.resolveContext
        ? await options.resolveContext(controller.signal)
        : { key: "runtime", discover: options.discover! };
      controller.signal.throwIfAborted();
      contextKey = JSON.stringify([context.key, provider.id, provider.kind, provider.installStatus, provider.authStatus]);
      const candidate = cached.get(principal.userId);
      hit = candidate?.contextKey === contextKey ? candidate : undefined;
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = projectModels(await context.discover(controller.signal));
      controller.signal.throwIfAborted();
      const age = Math.max(1, Math.min(context.maxAgeMs ?? ttl, ttl));
      const retainOnRefresh = context.retainOnRefresh !== false;
      save({ contextKey, value, expiresAt: Date.now() + age,
        staleAt: Date.now() + (retainOnRefresh ? 300_000 : age), retainOnRefresh });
      return value;
    };
    const request = Promise.race([Promise.resolve().then(load), deadline])
      .catch((_error: unknown) => {
        console.warn("[chat-providers] Claude model discovery unavailable");
        const value = hit && hit.staleAt > Date.now() ? hit.value : null;
        if (contextKey) save({ contextKey, value,
          expiresAt: value ? Math.min(Date.now() + 5_000, hit!.staleAt) : Date.now() + 5_000,
          staleAt: hit?.staleAt ?? 0, retainOnRefresh: hit?.retainOnRefresh ?? false });
        return value;
      }).finally(() => {
        clearTimeout(timer);
        controller.abort();
        pending.delete(principal.userId);
      });
    state.request = request;
    pending.set(principal.userId, state);
    return request;
  };
  source.invalidate = (principal: RequestPrincipal) => {
    const hit = cached.get(principal.userId);
    if (hit?.retainOnRefresh) hit.expiresAt = 0;
    else cached.delete(principal.userId);
    const existing = pending.get(principal.userId);
    if (existing) existing.invalidated = true;
  };
  return source;
}
