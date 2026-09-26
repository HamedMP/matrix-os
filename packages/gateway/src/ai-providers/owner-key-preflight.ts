import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";
import { isSupportedGenericHarnessCredentialRoute, type AiProviderReadiness, type ProviderAccessSource } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { boundedOperation } from "../bounded-operation.js";
import { readSavedProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type { AiProviderHealthProbe } from "./service.js";
export const OwnerAnthropicKeyConfig = z.object({ kernel: z.object({ anthropicApiKey: z.string().trim().max(4096).regex(/^sk-ant-api[A-Za-z0-9_-]+$/) }) });
export const ownerKeyFingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
export const OwnerKeyPreflightContext = z.strictObject({ modelId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  credentialFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/) });
const Count = z.strictObject({ input_tokens: z.number().int().min(1).max(10_000) });
function cancel(body: ReadableStream | ReadableStreamDefaultReader | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[ai-providers] Owner health body cleanup failed", error instanceof Error ? error.name : "UnknownError"));
}
/** Free fixed synthetic token counting verifies auth/endpoint only, never quota or inference success. */
export function createOwnerAnthropicKeyPreflight(options: { homePath: string; fetchFn?: typeof fetch; now?: () => number }): AiProviderHealthProbe {
  const now = options.now ?? Date.now;
  let cached: { fingerprint: string; expires: number; readiness: AiProviderReadiness } | undefined;
  let unfinished: Promise<AiProviderReadiness | null> | undefined;
  async function binding(context: z.infer<typeof OwnerKeyPreflightContext>, signal: AbortSignal) {
    signal.throwIfAborted();
    const document = await readBoundedJsonFileWithIdentity(join(options.homePath, "system/config.json"), 64 * 1024);
    const config = OwnerAnthropicKeyConfig.safeParse(document?.value);
    const intent = await readSavedProviderSettingsConfiguration(join(options.homePath, "system/ai-providers/settings.json"));
    signal.throwIfAborted();
    if (!config.success || !document || !intent) return null;
    const key = config.data.kernel.anthropicApiKey;
    const selected = intent.harnesses.filter(h => h.harness === "hermes" && h.enabled);
    const account = intent.accountProfiles.filter(a => a.id === "owner_anthropic" && a.providerId === "anthropic"
      && a.authMethod === "api_key" && a.accessSourceId === "owner_anthropic_key");
    const harness = selected[0];
    // Reuse the shared supported-route rule; the exact owner-key intent is narrower.
    const source: ProviderAccessSource = { id: "owner_anthropic_key", kind: "provider_account", providerId: "anthropic", accountId: "owner_anthropic",
      fundingKind: "owner_api_key", displayName: "Owner key", eligibleModelIds: [context.modelId],
      readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
      usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "account", reason: "unknown", asOf: null } };
    if (selected.length !== 1 || account.length !== 1 || !harness || !isSupportedGenericHarnessCredentialRoute(harness, source)
      || harness.selectedAccountId !== "owner_anthropic" || harness.accessSourceId !== source.id || harness.route.kind !== "configurable"
      || harness.route.providerId !== "anthropic" || harness.route.modelId !== context.modelId || ownerKeyFingerprint(key) !== context.credentialFingerprint) return null;
    return { key, fingerprint: createHash("sha256").update(JSON.stringify([context.credentialFingerprint, context.modelId, intent.revision, document.identity, harness])).digest("hex") };
  }
  return async (sourceId, parent, rawContext) => {
    const parsed = OwnerKeyPreflightContext.safeParse(rawContext);
    if (sourceId !== "owner_anthropic_key" || !parsed.success) return null;
    // At most one unfinished operation, including a dependency ignoring abort.
    if (unfinished) return null;
    const execute = async (parentSignal: AbortSignal): Promise<AiProviderReadiness | null> => {
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(2_000)]);
      const initial = await binding(parsed.data, signal);
      if (!initial) return null;
      if (cached && cached.fingerprint === initial.fingerprint && cached.expires > now()) return { ...cached.readiness };
      cached = undefined;
      const response = await (options.fetchFn ?? fetch)("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST", redirect: "error", signal,
        headers: { "x-api-key": initial.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: parsed.data.modelId, messages: [{ role: "user", content: "Health check." }] }),
      });
      if (signal.aborted || response.status !== 200 || !response.body || Number(response.headers.get("content-length") ?? 0) > 1024) {
        cancel(response.body); signal.throwIfAborted(); return null;
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let count = 0;
      const onAbort = () => cancel(reader); signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 || ++count > 4096) { cancel(reader); return null; }
          chunks.push(part.value);
        }
        const bytes = Buffer.concat(chunks);
        if (!Count.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).success) return null;
      } finally { signal.removeEventListener("abort", onAbort); }
      const current = await binding(parsed.data, signal);
      signal.throwIfAborted();
      if (!current || current.fingerprint !== initial.fingerprint) return null;
      const checked = now(); const readiness: AiProviderReadiness = { state: "ready", checkedAt: new Date(checked).toISOString(),
        staleAfter: new Date(checked + 30_000).toISOString(), action: "none", safeReason: null };
      cached = { fingerprint: initial.fingerprint, expires: checked + 30_000, readiness };
      return { ...readiness };
    };
    const operation = boundedOperation(signal => {
      const work = execute(signal);
      unfinished = work;
      void work.then(() => { if (unfinished === work) unfinished = undefined; },
        () => { if (unfinished === work) unfinished = undefined; });
      return work;
    }, 2_000, parent);
    unfinished = operation;
    try { return await operation; }
    catch (error: unknown) {
      cached = undefined;
      console.warn("[ai-providers] Owner auth health unavailable", error instanceof Error ? error.name : "UnknownError"); return null;
    } finally { if (unfinished === operation) unfinished = undefined; }
  };
}
