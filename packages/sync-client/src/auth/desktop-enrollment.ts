import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { platform as hostPlatform } from "node:os";
import { z } from "zod/v4";
import {
  SyncDirectionSchema,
  SyncMappingConfigSchema,
  SyncOwnerIdSchema,
  SyncRemotePrefixSchema,
  SyncRuntimeSlotSchema,
  type SyncMappingConfig,
} from "@matrix-os/contracts/sync";
import { enrollSyncDeviceAuth, revokeSyncDeviceAuth } from "./sync-device.js";
import {
  loadProfileAuth,
  saveProfileAuth,
  saveProfileAuthToMacKeychain,
  type AuthData,
} from "./token-store.js";
import {
  generatePeerId,
  getConfigDir,
  type SyncConfig,
} from "../lib/config.js";
import {
  loadProfileSyncConfig,
  saveProfileSyncConfig,
} from "../lib/profile-sync-config.js";
import { loadProfiles, saveProfiles, type Profile } from "../lib/profiles.js";
import {
  loadSyncMappingConfig,
  migrateLegacySyncConfig,
  saveSyncMappingConfig,
} from "../lib/sync-mapping-config.js";
import {
  createStandaloneDaemonServiceCommand,
  installService,
  startService,
} from "../daemon/service.js";

const MAX_DESKTOP_ENROLLMENT_INPUT_BYTES = 32 * 1024;
const ProfileNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/);
const TrustedSyncOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:"
    || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "Sync endpoints must use HTTPS (or localhost HTTP for development)");

const DesktopCredentialInputSchema = z.object({
  schemaVersion: z.literal(1),
  profile: ProfileNameSchema,
  platformUrl: TrustedSyncOriginSchema,
  desktopAccessToken: z.string().min(1).max(16_384),
  deviceName: z.string().trim().min(1).max(120),
  expectedIdentity: z.object({
    userId: SyncOwnerIdSchema,
    handle: z.string().min(1).max(128),
    runtimeSlot: SyncRuntimeSlotSchema,
  }).strict(),
}).strict();

export const DesktopReauthorizationInputSchema = DesktopCredentialInputSchema;

export const DesktopEnrollmentInputSchema = DesktopCredentialInputSchema.extend({
  gatewayUrl: TrustedSyncOriginSchema,
  localRoot: z.string().min(1).max(4096).refine(isAbsolute, "Local root must be absolute"),
  label: z.string().trim().min(1).max(120).optional(),
  remotePrefix: SyncRemotePrefixSchema,
  direction: SyncDirectionSchema,
  propagateDeletes: z.boolean().default(false),
  excludes: z.array(z.string().min(1).max(1024)).max(256).default([]),
}).strict();

export type DesktopEnrollmentInput = z.infer<typeof DesktopEnrollmentInputSchema>;
export type DesktopReauthorizationInput = z.infer<typeof DesktopReauthorizationInputSchema>;

export interface DesktopEnrollmentDependencies {
  enroll: typeof enrollSyncDeviceAuth;
  revoke?: typeof revokeSyncDeviceAuth;
  saveCredential: (profile: string, credential: AuthData) => Promise<void>;
  saveProfile: (profile: string, value: Profile) => Promise<void>;
  loadLegacyConfig: (profile: string) => Promise<SyncConfig | null>;
  saveLegacyConfig: (config: SyncConfig, profile: string) => Promise<void>;
  loadMappingConfig: (
    profile: string,
    scope: { ownerId: string; runtimeSlot: string },
  ) => Promise<SyncMappingConfig | null>;
  saveMappingConfig: (input: {
    config: SyncMappingConfig;
    expectedRevision: number;
  }) => Promise<void>;
  installAndStart: () => Promise<void>;
  randomId?: () => string;
}

export interface DesktopReauthorizationDependencies {
  enroll: typeof enrollSyncDeviceAuth;
  revoke?: typeof revokeSyncDeviceAuth;
  loadCredential: (profile: string) => Promise<AuthData | null>;
  saveCredential: (profile: string, credential: AuthData) => Promise<void>;
  installAndStart: () => Promise<void>;
}

async function revokeCredentialBestEffort(
  revoke: typeof revokeSyncDeviceAuth | undefined,
  request: Parameters<typeof revokeSyncDeviceAuth>[0],
  operation: "new_credential_rollback" | "previous_credential_retirement",
): Promise<void> {
  if (!revoke) return;
  try {
    await revoke(request);
  } catch (err: unknown) {
    console.warn("[sync/enrollment] Credential cleanup failed", {
      operation,
      errorType: err instanceof Error ? err.name : "NonErrorThrown",
    });
  }
}

async function readDesktopInput<T>(
  stream: AsyncIterable<Uint8Array | string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_DESKTOP_ENROLLMENT_INPUT_BYTES) {
      throw new Error("desktop_enrollment_input_too_large");
    }
    chunks.push(bytes);
  }
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "desktop_enrollment_input_too_large") throw err;
    throw new Error("desktop_enrollment_input_invalid");
  }
}

export async function readDesktopEnrollmentInput(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<DesktopEnrollmentInput> {
  return readDesktopInput(stream, DesktopEnrollmentInputSchema);
}

export function readDesktopReauthorizationInput(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<DesktopReauthorizationInput> {
  return readDesktopInput(stream, DesktopReauthorizationInputSchema);
}

function buildMappingConfig(
  input: DesktopEnrollmentInput,
  peerId: string,
  id: string,
): SyncMappingConfig {
  const migrated = migrateLegacySyncConfig({
    legacy: {
      profile: input.profile,
      platformUrl: input.platformUrl,
      gatewayUrl: input.gatewayUrl,
      syncPath: input.localRoot,
      gatewayFolder: input.remotePrefix,
      peerId,
      pauseSync: false,
      syncDaemonRuntime: "standalone",
    },
    profile: input.profile,
    ownerId: input.expectedIdentity.userId,
    runtimeSlot: input.expectedIdentity.runtimeSlot,
    deviceId: peerId,
  });
  return SyncMappingConfigSchema.parse({
    ...migrated,
    mappings: migrated.mappings.map((mapping) => ({
      ...mapping,
      id,
      ...(input.label ? { label: input.label } : {}),
      direction: input.direction,
      propagateDeletes: input.propagateDeletes,
      excludes: input.excludes,
    })),
  });
}

export async function performDesktopEnrollment(
  rawInput: DesktopEnrollmentInput,
  deps: DesktopEnrollmentDependencies,
): Promise<{
  ok: true;
  profile: string;
  mappingId: string;
  userId: string;
  runtimeSlot: string;
}> {
  const input = DesktopEnrollmentInputSchema.parse(rawInput);
  const credential = await deps.enroll({
    platformUrl: input.platformUrl,
    desktopAccessToken: input.desktopAccessToken,
    deviceName: input.deviceName,
    expected: input.expectedIdentity,
  });
  try {
    await deps.saveCredential(input.profile, credential);
  } catch (err: unknown) {
    await revokeCredentialBestEffort(
      deps.revoke,
      { platformUrl: input.platformUrl, auth: credential },
      "new_credential_rollback",
    );
    throw err;
  }

  await deps.saveProfile(input.profile, {
    platformUrl: input.platformUrl,
    gatewayUrl: input.gatewayUrl,
  });

  const previous = await deps.loadLegacyConfig(input.profile);
  const peerId = previous?.peerId ?? generatePeerId();
  const legacy: SyncConfig = {
    ...(previous ?? {}),
    profile: input.profile,
    platformUrl: input.platformUrl,
    gatewayUrl: input.gatewayUrl,
    syncPath: input.localRoot,
    gatewayFolder: input.remotePrefix,
    peerId,
    pauseSync: false,
    syncDaemonRuntime: "standalone",
  };
  await deps.saveLegacyConfig(legacy, input.profile);

  const scope = {
    ownerId: input.expectedIdentity.userId,
    runtimeSlot: input.expectedIdentity.runtimeSlot,
  };
  const existing = await deps.loadMappingConfig(input.profile, scope);
  let mappingId: string;
  if (existing) {
    const matching = existing.mappings.find((mapping) => (
      mapping.localRoot === input.localRoot
      && mapping.remotePrefix === input.remotePrefix
      && mapping.direction === input.direction
    ));
    if (!matching) throw new Error("desktop_enrollment_existing_mappings");
    mappingId = matching.id;
    if (!existing.enabled || !matching.enabled) {
      await deps.saveMappingConfig({
        expectedRevision: existing.revision,
        config: {
          ...existing,
          revision: existing.revision + 1,
          enabled: true,
          mappings: existing.mappings.map((mapping) => (
            mapping.id === matching.id ? { ...mapping, enabled: true } : mapping
          )),
        },
      });
    }
  } else {
    mappingId = (deps.randomId ?? randomUUID)();
    await deps.saveMappingConfig({
      config: buildMappingConfig(input, peerId, mappingId),
      expectedRevision: -1,
    });
  }

  await deps.installAndStart();
  return {
    ok: true,
    profile: input.profile,
    mappingId,
    userId: input.expectedIdentity.userId,
    runtimeSlot: input.expectedIdentity.runtimeSlot,
  };
}

export async function performDesktopReauthorization(
  rawInput: DesktopReauthorizationInput,
  deps: DesktopReauthorizationDependencies,
): Promise<{ ok: true; profile: string }> {
  const input = DesktopReauthorizationInputSchema.parse(rawInput);
  const previousCredential = await deps.loadCredential(input.profile);
  const credential = await deps.enroll({
    platformUrl: input.platformUrl,
    desktopAccessToken: input.desktopAccessToken,
    deviceName: input.deviceName,
    expected: input.expectedIdentity,
  });
  try {
    await deps.saveCredential(input.profile, credential);
  } catch (err: unknown) {
    await revokeCredentialBestEffort(
      deps.revoke,
      { platformUrl: input.platformUrl, auth: credential },
      "new_credential_rollback",
    );
    throw err;
  }
  if (previousCredential) {
    await revokeCredentialBestEffort(
      deps.revoke,
      {
        platformUrl: input.platformUrl,
        auth: previousCredential,
      },
      "previous_credential_retirement",
    );
  }
  await deps.installAndStart();
  return { ok: true, profile: input.profile };
}

export async function runDesktopEnrollmentFromStdin(): Promise<void> {
  const input = await readDesktopEnrollmentInput(process.stdin);
  const configDir = process.env.MATRIXOS_CONFIG_DIR ?? getConfigDir();
  const saveDesktopCredential = hostPlatform() === "darwin"
    ? (profile: string, credential: AuthData) => saveProfileAuthToMacKeychain(
        profile,
        credential,
        configDir,
      )
    : (profile: string, credential: AuthData) => saveProfileAuth(
        profile,
        credential,
        configDir,
      );
  const result = await performDesktopEnrollment(input, {
    enroll: enrollSyncDeviceAuth,
    revoke: revokeSyncDeviceAuth,
    saveCredential: saveDesktopCredential,
    saveProfile: async (profile, value) => {
      const profiles = await loadProfiles({ configDir, migrateLegacyFiles: false });
      await saveProfiles({
        ...profiles,
        profiles: { ...profiles.profiles, [profile]: value },
      }, configDir);
    },
    loadLegacyConfig: async (profile) => (
      await loadProfileSyncConfig({ configDir, profileName: profile })
    )?.config ?? null,
    saveLegacyConfig: (config, profile) => saveProfileSyncConfig(config, {
      configDir,
      profileName: profile,
    }),
    loadMappingConfig: (profile, scope) => loadSyncMappingConfig({
      configDir,
      profile,
      scope,
    }),
    saveMappingConfig: (value) => saveSyncMappingConfig({
      configDir,
      ...value,
    }),
    installAndStart: async () => {
      await installService(createStandaloneDaemonServiceCommand());
      await startService();
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runDesktopReauthorizationFromStdin(): Promise<void> {
  const input = await readDesktopReauthorizationInput(process.stdin);
  const configDir = process.env.MATRIXOS_CONFIG_DIR ?? getConfigDir();
  const saveCredential = hostPlatform() === "darwin"
    ? (profile: string, credential: AuthData) => saveProfileAuthToMacKeychain(profile, credential, configDir)
    : (profile: string, credential: AuthData) => saveProfileAuth(profile, credential, configDir);
  const result = await performDesktopReauthorization(input, {
    enroll: enrollSyncDeviceAuth,
    revoke: revokeSyncDeviceAuth,
    loadCredential: (profile) => loadProfileAuth(profile, configDir),
    saveCredential,
    installAndStart: async () => {
      await installService(createStandaloneDaemonServiceCommand());
      await startService();
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
