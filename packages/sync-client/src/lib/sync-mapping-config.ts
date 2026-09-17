import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SyncMappingConfigSchema,
  SyncScopeSchema,
  type SyncMappingConfig,
  type SyncScope,
} from "@matrix-os/contracts/sync";
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

export function syncMappingStatePath(
  configDir: string,
  config: Pick<SyncMappingConfig, "profile" | "ownerId" | "runtimeSlot">,
  mappingId: string,
): string {
  const id = SyncMappingConfigSchema.shape.mappings.element.shape.id.parse(mappingId);
  return join(
    profilePath(config.profile, configDir),
    "sync",
    deriveSyncScopeId({ ownerId: config.ownerId, runtimeSlot: config.runtimeSlot }),
    "state",
    `${id}.json`,
  );
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

export async function listSyncMappingConfigs(
  configDir: string,
): Promise<SyncMappingConfig[]> {
  const profilesDir = join(configDir, "profiles");
  let profiles;
  try {
    profiles = await readdir(profilesDir, { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const configs: SyncMappingConfig[] = [];
  for (const profile of profiles.slice(0, 64)) {
    if (!profile.isDirectory() || profile.isSymbolicLink()) continue;
    const syncDir = join(profilesDir, profile.name, "sync");
    let scopes;
    try {
      scopes = await readdir(syncDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const scope of scopes.slice(0, 64)) {
      if (!scope.isDirectory() || scope.isSymbolicLink() || !scope.name.startsWith("scope-")) continue;
      const path = join(syncDir, scope.name, "config.json");
      try {
        if ((await lstat(path)).isSymbolicLink()) throw codedError("sync_config_symlink");
        configs.push(SyncMappingConfigSchema.parse(JSON.parse(await readFile(path, "utf8"))));
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }
  }
  return configs.slice(0, 256);
}

export async function migrateLegacySyncStateFile(input: {
  legacyStateFile: string;
  targetStateFile: string;
  maxBytes?: number;
}): Promise<"copied" | "source_missing" | "target_exists"> {
  const maxBytes = input.maxBytes ?? 32 * 1024 * 1024;
  let sourceStat;
  try {
    sourceStat = await lstat(input.legacyStateFile);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "source_missing";
    }
    throw err;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > maxBytes) {
    throw codedError("sync_legacy_state_unsafe");
  }
  await mkdir(dirname(input.targetStateFile), { recursive: true, mode: 0o700 });
  const bytes = await readFile(input.legacyStateFile);
  try {
    const target = await open(input.targetStateFile, "wx", 0o600);
    try {
      await target.writeFile(bytes);
    } finally {
      await target.close();
    }
    return "copied";
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return "target_exists";
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
