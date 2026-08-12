import type { Kysely } from "kysely";
import type { CodingAgentProviderAdapter } from "./provider-adapter.js";
import type { CodingAgentProviderRegistry } from "./provider-registry.js";
import {
  CodingAgentProviderUsageSnapshotRepository,
  type ProviderUsageDatabase,
} from "./provider-usage-repository.js";
import {
  createCodingAgentProviderUsageService,
  type CodingAgentUsageProviderAdapter,
  type CodingAgentProviderUsageService,
} from "./provider-usage.js";

const BUILTIN_PROVIDER_USAGE_IDS = ["claude", "codex", "opencode", "pi"] as const;

function withBuiltinProviderUsageCatalog(
  providers: readonly CodingAgentProviderAdapter[],
): CodingAgentUsageProviderAdapter[] {
  const catalog: CodingAgentUsageProviderAdapter[] = [...providers];
  for (const providerId of BUILTIN_PROVIDER_USAGE_IDS) {
    if (!catalog.some((provider) => provider.providerId === providerId)) {
      catalog.push({ providerId });
    }
  }
  return catalog;
}

export interface GatewayCodingAgentProviderUsageOptions {
  kysely: Kysely<any> | null;
  providers: readonly CodingAgentProviderAdapter[];
  providerRegistry: Pick<CodingAgentProviderRegistry, "listProviders">;
  runtimeId: string;
  now?: () => Date;
}

export async function createGatewayCodingAgentProviderUsageService(
  options: GatewayCodingAgentProviderUsageOptions,
): Promise<CodingAgentProviderUsageService | undefined> {
  if (!options.kysely) return undefined;

  const snapshots = new CodingAgentProviderUsageSnapshotRepository(
    options.kysely as Kysely<ProviderUsageDatabase>,
  );
  await snapshots.bootstrap();
  return createCodingAgentProviderUsageService({
    providers: withBuiltinProviderUsageCatalog(options.providers),
    providerRegistry: options.providerRegistry,
    snapshotRepository: snapshots,
    runtimeId: options.runtimeId,
    now: options.now,
  });
}
