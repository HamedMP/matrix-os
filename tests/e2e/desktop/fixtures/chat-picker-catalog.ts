import { CanonicalProviderCatalogSchema, ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { createLegacyGlobalProviderCatalog } from "../../../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import { providerAuthSettingsSnapshot } from "./provider-auth-gateway";

export function pickerCatalog() {
  const catalog = createLegacyGlobalProviderCatalog({ hasProject: false });
  const hermes = catalog.instances[0]!;
  hermes.models[0] = { ...hermes.models[0]!, id: "gpt-5.6-sol", displayName: "gpt-5.6-sol" };
  hermes.defaultSelection = { instanceId: hermes.id, model: "gpt-5.6-sol" };
  const codex = catalog.instances[1]!;
  codex.availability = "auth_required";
  codex.setupActions = [{ id: "codex_connect", kind: "open_settings", label: "Connect Codex" }];
  catalog.drivers.push({ kind: "claude_code", displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" });
  catalog.instances.push({ ...codex, id: "claude_default", driverKind: "claude_code", displayName: "Claude Code",
    setupActions: [{ id: "claude_connect", kind: "foreground_terminal", label: "Connect Claude", command: "claude auth login" }] });
  return CanonicalProviderCatalogSchema.parse(catalog);
}

// Codex is connected in Settings; Claude still needs login in the picker.
export function connectedOtherProvider(authenticated: boolean) {
  const snapshot = providerAuthSettingsSnapshot(authenticated);
  snapshot.modelProviders.push({ id: "openai", displayName: "OpenAI", models: [{ id: "openai/gpt-5.6-sol", displayName: "GPT-5.6-Sol", enabled: true }] });
  snapshot.accounts.push({ ...snapshot.accounts[0]!, id: "codex_account", providerId: "openai", displayName: "Codex",
    authState: "authenticated", accessSourceId: "codex_account_source" });
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "codex_account_source", providerId: "openai",
    accountId: "codex_account", displayName: "Codex account", eligibleModelIds: ["openai/gpt-5.6-sol"], readiness: { state: "ready", checkedAt: snapshot.refreshedAt, staleAfter: null, action: "none", safeReason: null } });
  return ProviderSettingsSnapshotSchema.parse(snapshot);
}

