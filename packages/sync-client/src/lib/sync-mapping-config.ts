import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SyncMappingConfigSchema,
  SyncScopeSchema,
  type SyncMappingConfig,
  type SyncScope,
} from "@matrix-os/contracts";
import type { SyncConfig } from "./config.js";
import { normalizeGatewayFolder } from "./config.js";
import { profilePath } from "./profiles.js";
import { writeUtf8FileAtomic } from "./atomic-write.js";

export interface SyncMappingConfigLocation {
  configDir: string;
  profile: string;
  scope: SyncScope;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function deterministicUuid(input: string): string {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveSyncScopeId(scope: SyncScope): string {
  const parsed = SyncScopeSchema.parse(scope);
  const digest = createHash("sha256")
    .update(JSON.stringify([parsed.ownerId, parsed.runtimeSlot]))
    .digest("hex")
    .slice(0, 24);
  return `scope-${digest}`;
}

export function syncMappingConfigPath(
  configDir: string,
  profile: string,
  scope: SyncScope,
): string {
  return join(profilePath(profile, configDir), "sync", deriveSyncScopeId(scope), "config.json");
}

export function migrateLegacySyncConfig(input: {
  legacy: SyncConfig;
  profile: string;
  ownerId: string;
  runtimeSlot: string;
  deviceId: string;
}): SyncMappingConfig {
  const scope = SyncScopeSchema.parse({
    ownerId: input.ownerId,
    runtimeSlot: input.runtimeSlot,
  });
  const remotePrefix = normalizeGatewayFolder(input.legacy.gatewayFolder ?? "");
  const enabled = !input.legacy.pauseSync;
  const id = deterministicUuid(JSON.stringify([
    input.profile,
    scope.ownerId,
    scope.runtimeSlot,
    input.deviceId,
    input.legacy.syncPath,
    remotePrefix,
  ]));
  return SyncMappingConfigSchema.parse({
    schemaVersion: 2,
    revision: 0,
    profile: input.profile,
    ...scope,
    deviceId: input.deviceId,
    enabled,
    mappings: [{
      id,
      label: remotePrefix || "Matrix Home",
      localRoot: input.legacy.syncPath,
      remotePrefix,
      direction: "two_way",
      enabled,
      // Existing installs must explicitly review deletion propagation.
      propagateDeletes: false,
      excludes: input.legacy.exclude ?? [],
    }],
  });
}

export async function loadSyncMappingConfig(
  location: SyncMappingConfigLocation,
): Promise<SyncMappingConfig | null> {
  const path = syncMappingConfigPath(
    location.configDir,
    location.profile,
    location.scope,
  );
  try {
    return SyncMappingConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (err: unknown) {
    if (
      err instanceof Error
      && "code" in err
      && (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function saveSyncMappingConfig(input: {
  configDir: string;
  config: SyncMappingConfig;
  expectedRevision: number;
}): Promise<void> {
  const config = SyncMappingConfigSchema.parse(input.config);
  if (config.revision !== input.expectedRevision + 1) {
    throw codedError("sync_config_revision_invalid");
  }
  const scope = { ownerId: config.ownerId, runtimeSlot: config.runtimeSlot };
  const path = syncMappingConfigPath(input.configDir, config.profile, scope);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = join(dirname(path), ".config.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (err: unknown) {
    if (
      err instanceof Error
      && "code" in err
      && (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw codedError("sync_config_busy");
    }
    throw err;
  }

  try {
    const current = await loadSyncMappingConfig({
      configDir: input.configDir,
      profile: config.profile,
      scope,
    });
    if ((current?.revision ?? -1) !== input.expectedRevision) {
      throw codedError("sync_config_revision_conflict");
    }
    await writeUtf8FileAtomic(path, JSON.stringify(config, null, 2), 0o600);
  } finally {
    await lock.close();
    await unlink(lockPath).catch((err: unknown) => {
      if (
        !(err instanceof Error)
        || !("code" in err)
        || (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
    });
  }
}
