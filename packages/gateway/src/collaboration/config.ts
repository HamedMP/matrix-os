/**
 * Gateway collaboration configuration (S20 / T099).
 *
 * There is no release flag: collaboration wiring always constructs. When the
 * runtime, platform or service-token configuration is incomplete
 * the loader returns `null` and the composition root registers the
 * fail-closed routes from `./fail-closed.js` instead of skipping construction.
 * Organization membership, evaluated on the home, is the only gate.
 */

const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GatewayCollaborationConfig {
  runtimeId: string;
  /** Legacy test fixture only; the production loader never accepts V1 proof keys. */
  activeKeyId?: string;
  proofKeys?: Readonly<Record<string, string>>;
  platformBaseUrl: string;
  serviceToken: string;
  /** S05: browser origins allowed to open direct sessions; empty means direct sessions fail closed. */
  clientOrigins: readonly string[];
  /** S05: owner and relay handle for runtime registration; absent means the home never registers. */
  ownerId?: string;
  relayHandle?: string;
}

export type GatewayCollaborationConfigurationHealth =
  | { configured: true }
  | { configured: false; reason: GatewayCollaborationConfigurationFailure };

export type GatewayCollaborationConfigurationFailure =
  | "runtime_identity_missing"
  | "signing_configuration_missing"
  | "platform_configuration_missing"
  | "owner_database_missing"
  | "construction_failed";

export function loadGatewayCollaborationConfig(env: NodeJS.ProcessEnv): GatewayCollaborationConfig | null {
  const health = describeRuntimeConfiguration(env);
  if (!health.configured) return null;
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  if (!runtimeId) return null;
  return {
    runtimeId,
    platformBaseUrl: env.PLATFORM_INTERNAL_URL!.trim(),
    serviceToken: env.UPGRADE_TOKEN!,
    clientOrigins: parseClientOrigins(env.MATRIX_COLLABORATION_CLIENT_ORIGINS),
    ...(env.MATRIX_USER_ID?.trim() ? { ownerId: env.MATRIX_USER_ID.trim() } : {}),
    ...(env.MATRIX_HANDLE?.trim() ? { relayHandle: env.MATRIX_HANDLE.trim() } : {}),
  };
}

/**
 * Reports configuration health without reading any release flag. The gateway
 * exposes this through `/api/system/info` so operators can see why
 * collaboration is fail-closed on a home computer.
 */
export function describeGatewayCollaborationConfiguration(
  env: NodeJS.ProcessEnv,
): GatewayCollaborationConfigurationHealth {
  const base = describeRuntimeConfiguration(env);
  if (!base.configured) return base;
  if (!env.DATABASE_URL) return { configured: false, reason: "owner_database_missing" };
  return { configured: true };
}

function describeRuntimeConfiguration(env: NodeJS.ProcessEnv): GatewayCollaborationConfigurationHealth {
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  if (!runtimeId) return { configured: false, reason: "runtime_identity_missing" };
  const platformBaseUrl = env.PLATFORM_INTERNAL_URL?.trim();
  const serviceToken = env.UPGRADE_TOKEN;
  if (!platformBaseUrl || !serviceToken || Buffer.byteLength(serviceToken) < 32) {
    return { configured: false, reason: "platform_configuration_missing" };
  }
  return { configured: true };
}

/** S05: exact https origins, deduplicated; anything malformed is dropped so a typo cannot widen the allowlist. */
function parseClientOrigins(raw: string | undefined): string[] {
  const origins = new Set<string>();
  for (const value of (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 16)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:" && parsed.origin === value) origins.add(parsed.origin);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) console.warn("[collaboration] client origin parse failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return [...origins];
}
