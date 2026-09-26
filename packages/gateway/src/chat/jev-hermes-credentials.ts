import type { ProviderSnapshotReadOptions } from "../ai-providers/snapshot-read-options.js";
import { join } from "node:path";
import { z } from "zod/v4";
import { ProviderSettingsSnapshotSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { boundedOperation } from "../bounded-operation.js";
export type JevHermesCredentials = { provider: "anthropic"; model: string; apiMode: "anthropic_messages";
  baseUrl: "https://api.anthropic.com"; env: { ANTHROPIC_API_KEY: string } };
export class JevHermesSetupError extends Error {
  constructor() { super("This Inbox workflow requires the selected Hermes owner API-key account to be ready"); }
}
const Selection = z.strictObject({ instanceId: z.literal("hermes_default"),
  model: z.string().min(1).max(200).regex(/^anthropic:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/) });
const Config = z.object({ kernel: z.object({ anthropicApiKey: z.string().trim().min(1).max(4096).regex(/^sk-ant-api[A-Za-z0-9_-]+$/) }) });
/** Server-only fixed credential source. Never loads the owner's Hermes profile or copies it to a child. */
export function createJevHermesCredentialResolver(options: {
  homePath: string; ownerId: string | null;
  settings: { getSnapshot(options?: ProviderSnapshotReadOptions): Promise<ProviderSettingsSnapshot> };
  now?: () => number;
}) {
  return async (ownerId: string, rawSelection: unknown, signal?: AbortSignal): Promise<JevHermesCredentials> => {
    if (!options.ownerId || ownerId !== options.ownerId) throw new JevHermesSetupError();
    signal?.throwIfAborted();
    const parsed = Selection.safeParse(rawSelection);
    if (!parsed.success) throw new JevHermesSetupError();
    const model = parsed.data.model.slice("anthropic:".length);
    return boundedOperation(async (deadline) => {
      const value = ProviderSettingsSnapshotSchema.parse(await options.settings.getSnapshot({ refresh: true, suppressFundedProbes: true }));
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
      if (!selectedKey.success) throw new JevHermesSetupError();
      return { provider: "anthropic", model, apiMode: "anthropic_messages", baseUrl: "https://api.anthropic.com",
        env: { ANTHROPIC_API_KEY: selectedKey.data.kernel.anthropicApiKey } };
    }, 10_000, signal);
  };
}
