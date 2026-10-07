import { OwnerAnthropicKeyConfig, ownerKeyFingerprint } from "../ai-providers/owner-key-preflight.js";
import type { ProviderSnapshotReadOptions } from "../ai-providers/snapshot-read-options.js";
import { join } from "node:path";
import { z } from "zod/v4";
import { ProviderSettingsSnapshotSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { boundedOperation } from "../bounded-operation.js";
import { jevHermesRoute, type JevHermesProvider } from "@matrix-os/contracts";
import type { AgentRuntimeSource } from "../agent-config/service.js";
import { resolveJevHermesNativeCredential } from "./jev-hermes-native-credentials.js";
export type JevHermesCredentials = { provider: JevHermesProvider; model: string;
  apiMode: "anthropic_messages" | "codex_responses" | "chat_completions";
  baseUrl: string; env: { ANTHROPIC_API_KEY: string } | { MATRIX_JEV_PRIMARY_KEY: string } };
export class JevHermesSetupError extends Error {
  constructor() { super("This Inbox workflow requires a supported configured Hermes account"); }
}
const Selection = z.strictObject({ instanceId: z.literal("hermes_default"),
  model: z.string().min(1).max(200) });
const Config = OwnerAnthropicKeyConfig;
/** Server-only fixed credential source. Never loads the owner's Hermes profile or copies it to a child. */
export function createJevHermesCredentialResolver(options: {
  homePath: string; ownerId: string | null;
  settings: { getSnapshot(options?: ProviderSnapshotReadOptions): Promise<ProviderSettingsSnapshot> };
  now?: () => number;
  runtimeSource?: AgentRuntimeSource;
}) {
  return async (ownerId: string, rawSelection: unknown, signal?: AbortSignal): Promise<JevHermesCredentials> => {
    if (!options.ownerId || ownerId !== options.ownerId) throw new JevHermesSetupError();
    signal?.throwIfAborted();
    const parsed = Selection.safeParse(rawSelection);
    const route = parsed.success ? jevHermesRoute(parsed.data) : null;
    if (!route) throw new JevHermesSetupError();
    const model = route.model;
    return boundedOperation(async (deadline) => {
      if (route.provider !== "anthropic") {
        if (!options.runtimeSource) throw new JevHermesSetupError();
        const settings = ProviderSettingsSnapshotSchema.parse(await options.settings.getSnapshot({
          refresh: true, suppressFundedProbes: true, signal: deadline }));
        const current = (options.now ?? Date.now)();
        const refreshed = Date.parse(settings.refreshedAt);
        if (!Number.isFinite(refreshed) || current - refreshed < 0 || current - refreshed > 60_000) throw new JevHermesSetupError();
        return resolveJevHermesNativeCredential({ ...route, homePath: options.homePath,
          runtimeSource: options.runtimeSource, settings, now: options.now ?? Date.now, signal: deadline });
      }
      const before = await readBoundedJsonFileWithIdentity(join(options.homePath, "system/config.json"), 64 * 1024);
      const keyBefore = Config.safeParse(before?.value);
      if (!keyBefore.success) throw new JevHermesSetupError();
      const fingerprint = ownerKeyFingerprint(keyBefore.data.kernel.anthropicApiKey);
      const value = ProviderSettingsSnapshotSchema.parse(await options.settings.getSnapshot({ refresh: true, suppressFundedProbes: true,
        ownerKeyPreflight: { modelId: model, credentialFingerprint: fingerprint }, signal: deadline }));
      deadline.throwIfAborted();
      const current = (options.now ?? Date.now)();
      const fresh = (timestamp: string | null) => timestamp !== null && current - Date.parse(timestamp) >= 0
        && current - Date.parse(timestamp) <= 60_000;
      const harnesses = value.harnesses.filter((h) => h.harness === "hermes" && h.enabled);
      const source = value.accessSources.find((s) => s.id === "owner_anthropic_key");
      const accounts = value.accounts.filter((a) => a.providerId === "anthropic" && a.accessSourceId === "owner_anthropic_key");
      const harness = harnesses[0]; const account = accounts[0];
      if (!fresh(value.refreshedAt) || harnesses.length !== 1 || accounts.length !== 1 || !harness || !account || !source
        || harness.installState !== "installed" || harness.authState !== "authenticated" || harness.connectivity !== "online"
        || harness.route.providerId !== "anthropic" || harness.route.modelId !== model || harness.accessSourceId !== source.id
        || harness.selectedAccountId !== "owner_anthropic" || !harness.accountIds.includes("owner_anthropic")
        || account.id !== "owner_anthropic" || account.authMethod !== "api_key" || account.authState !== "authenticated"
        || source.kind !== "provider_account" || source.providerId !== "anthropic" || source.fundingKind !== "owner_api_key"
        || source.accountId !== account.id || source.readiness.state !== "ready" || !fresh(source.readiness.checkedAt)
        || (source.readiness.staleAfter !== null && Date.parse(source.readiness.staleAfter) <= current)
        || !source.eligibleModelIds.includes(model)) throw new JevHermesSetupError();
      const config = await readBoundedJsonFileWithIdentity(join(options.homePath, "system/config.json"), 64 * 1024);
      deadline.throwIfAborted();
      const selectedKey = Config.safeParse(config?.value);
      if (!selectedKey.success || ownerKeyFingerprint(selectedKey.data.kernel.anthropicApiKey) !== fingerprint
        || JSON.stringify(config?.identity) !== JSON.stringify(before?.identity)) throw new JevHermesSetupError();
      return { provider: "anthropic", model, apiMode: "anthropic_messages", baseUrl: "https://api.anthropic.com",
        env: { ANTHROPIC_API_KEY: selectedKey.data.kernel.anthropicApiKey } };
    }, 10_000, signal);
  };
}
