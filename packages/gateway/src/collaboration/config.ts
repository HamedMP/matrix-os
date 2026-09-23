/**
 * Gateway collaboration configuration (S20 / T099).
 *
 * There is no release flag: collaboration wiring always constructs. When the
 * signing, platform or service-token configuration is incomplete
 * the loader returns `null` and the composition root registers the
 * fail-closed routes from `./fail-closed.js` instead of skipping construction.
 * Organization membership, evaluated on the home, is the only gate.
 */

const MAX_PROOF_KEYS = 8;
const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GatewayCollaborationConfig {
  runtimeId: string;
  activeKeyId: string;
  proofKeys: Readonly<Record<string, string>>;
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
  const health = describeSigningConfiguration(env);
  if (!health.configured) return null;
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  const proofKeys = parseProofKeys(env.MATRIX_COLLABORATION_PROOF_KEYS);
  if (!runtimeId || !proofKeys) return null;
  return {
    runtimeId,
    activeKeyId: env.MATRIX_COLLABORATION_ACTIVE_KEY_ID!.trim(),
    proofKeys,
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
  const signing = describeSigningConfiguration(env);
  if (!signing.configured) return signing;
  if (!env.DATABASE_URL) return { configured: false, reason: "owner_database_missing" };
  return { configured: true };
}

function describeSigningConfiguration(env: NodeJS.ProcessEnv): GatewayCollaborationConfigurationHealth {
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  if (!runtimeId) return { configured: false, reason: "runtime_identity_missing" };
  const activeKeyId = env.MATRIX_COLLABORATION_ACTIVE_KEY_ID?.trim();
  const proofKeys = parseProofKeys(env.MATRIX_COLLABORATION_PROOF_KEYS);
  if (!activeKeyId || !proofKeys || !proofKeys[activeKeyId]) {
    return { configured: false, reason: "signing_configuration_missing" };
  }
  const platformBaseUrl = env.PLATFORM_INTERNAL_URL?.trim();
  const serviceToken = env.UPGRADE_TOKEN;
  if (!platformBaseUrl || !serviceToken || Buffer.byteLength(serviceToken) < 32) {
    return { configured: false, reason: "platform_configuration_missing" };
  }
  return { configured: true };
}

function parseProofKeys(raw: string | undefined): Record<string, string> | null {
  let proofKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    proofKeys = Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration] proof key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  const entries = Object.entries(proofKeys);
  if (entries.length < 1 || entries.length > MAX_PROOF_KEYS
    || entries.some(([keyId, key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId) || Buffer.byteLength(key) < 32)) {
    return null;
  }
  return proofKeys;
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
