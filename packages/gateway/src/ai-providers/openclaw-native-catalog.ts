import { AiNativeHarnessCatalogSchema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { AgentRuntimeSettingsSnapshot } from "../agent-config/service.js";
type Catalog = NonNullable<AiProviderSnapshotV3["nativeHarnessCatalog"]>;
/** The bounded native RPC read supplies auth status and models, never credentials. */
export function projectOpenClawNativeCatalog(snapshot: AgentRuntimeSettingsSnapshot, observedAt: Date): Catalog {
  const runtime = snapshot.runtime.options.find(row => row.id === "openclaw");
  if (snapshot.messaging.runtime !== "openclaw" || snapshot.runtime.selected !== "openclaw") return { profiles: [], failures: [] };
  if (runtime?.installState !== "installed" || runtime.health !== "healthy") return { profiles: [], failures: ["openclaw"] };
  const profiles: Catalog["profiles"] = [];
  for (const id of ["openai", "anthropic", "openrouter"]) {
    const rows = snapshot.providers.filter(row => row.runtime === "openclaw" && row.id === id);
    const provider = rows.length === 1 ? rows[0] : undefined;
    if (!provider || provider.authKind !== "api_key" || provider.authStatus.state !== "ready" || provider.authStatus.authenticated !== true) continue;
    if (provider.models.some(model => model.id.startsWith(`${id}:`))) return { profiles: [], failures: ["openclaw"] };
    profiles.push({ harness: "openclaw", providerId: id, providerDisplayName: provider.displayName,
      models: provider.models.filter(model => model.available).map(model => ({ id: `${id}:${model.id}`, displayName: model.displayName, enabled: true })),
      defaultModelId: snapshot.messaging.provider === id && snapshot.messaging.model ? `${id}:${snapshot.messaging.model}` : null,
      localObservation: { state: "present_unverified", checkedAt: observedAt.toISOString(), staleAfter: new Date(+observedAt + 5000).toISOString() } });
  }
  const result = AiNativeHarnessCatalogSchema.safeParse({ profiles, failures: [] });
  return result.success ? result.data : { profiles: [], failures: ["openclaw"] };
}
