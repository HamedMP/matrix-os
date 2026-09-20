import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import {
  loadConfig,
  SyncConfigSchema,
  type SyncConfig,
} from "./config.js";
import {
  loadProfiles,
  profileConfigPath,
} from "./profiles.js";
import { writeUtf8FileAtomic } from "./atomic-write.js";

const PROFILE_SLUG = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;
const SyncConfigBindingSchema = z.object({
  version: z.literal(1),
  profile: z.string().regex(PROFILE_SLUG),
});

export interface ProfileSyncConfigResolution {
  config: SyncConfig;
  profileName: string;
  configPath: string;
  source: "profile" | "legacy_migrated";
}

export interface ProfileSyncConfigOptions {
  configDir?: string;
  profileName?: string;
}

function defaultConfigDir(): string {
  return join(homedir(), ".matrixos");
}

export function syncConfigBindingPath(configDir = defaultConfigDir()): string {
  return join(configDir, "sync-profile.json");
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function readBinding(configDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(syncConfigBindingPath(configDir), "utf-8"));
    return SyncConfigBindingSchema.parse(parsed).profile;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw err;
  }
}

async function writeBinding(configDir: string, profile: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(
    syncConfigBindingPath(configDir),
    JSON.stringify({ version: 1, profile }, null, 2),
    0o600,
  );
}

function normalizedConfig(config: SyncConfig, profile: string): SyncConfig {
  return SyncConfigSchema.parse({ ...config, profile });
}

function configsMatch(left: SyncConfig, right: SyncConfig, profile: string): boolean {
  return JSON.stringify(normalizedConfig(left, profile)) ===
    JSON.stringify(normalizedConfig(right, profile));
}

async function publishExclusive(filePath: string, contents: string, mode: number): Promise<boolean> {
  const tempPath = `${filePath}.matrixos-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: "utf-8", flag: "wx", mode });
    // Hard-link publication is atomic and cannot replace a concurrent winner.
    // No persistent lock exists, so a killed process cannot block future migration.
    await link(tempPath, filePath);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      await unlink(tempPath);
    } catch (err: unknown) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
    }
  }
}

async function migrateLegacyConfig(
  configDir: string,
  profileName: string,
  legacy: SyncConfig,
): Promise<SyncConfig> {
  const destination = profileConfigPath(profileName, configDir);
  const existing = await loadConfig(destination);
  if (existing) {
    if (!configsMatch(existing, legacy, profileName)) throw codedError("sync_config_ambiguous");
    return normalizedConfig(existing, profileName);
  }
  const legacyPath = join(configDir, "config.json");
  const legacyRaw = await readFile(legacyPath, "utf-8");
  const legacyStat = await stat(legacyPath);
  const migrated = normalizedConfig(legacy, profileName);
  const migrationDir = join(configDir, "migrations", "sync-config-v1");
  await mkdir(migrationDir, { recursive: true, mode: 0o700 });
  await publishExclusive(join(migrationDir, "legacy-config.json"), legacyRaw, legacyStat.mode & 0o777);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (!await publishExclusive(destination, JSON.stringify(migrated, null, 2), legacyStat.mode & 0o777)) {
    const winner = await loadConfig(destination);
    if (!winner || !configsMatch(winner, legacy, profileName)) throw codedError("sync_config_ambiguous");
  }
  await writeUtf8FileAtomic(
    join(migrationDir, "journal.json"),
    JSON.stringify({
      version: 1,
      profile: profileName,
      sourceSha256: createHash("sha256").update(legacyRaw).digest("hex"),
      migratedAt: new Date().toISOString(),
    }, null, 2),
    0o600,
  );
  return migrated;
}
export async function loadProfileSyncConfig(
  options: ProfileSyncConfigOptions = {},
): Promise<ProfileSyncConfigResolution | null> {
  const configDir = options.configDir ?? defaultConfigDir();
  const profiles = await loadProfiles({ configDir, migrateLegacyFiles: false });
  const binding = await readBinding(configDir);
  // Explicit selection and a durable daemon binding outrank rollback data.
  const selected = options.profileName ?? binding;
  if (selected) {
    if (!profiles.profiles[selected]) throw codedError("profile_not_found");
    const configPath = profileConfigPath(selected, configDir);
    const saved = await loadConfig(configPath);
    if (saved) return { config: normalizedConfig(saved, selected), profileName: selected, configPath, source: "profile" };
  }
  const legacy = await loadConfig(join(configDir, "config.json"));
  const profileName = options.profileName ?? binding ?? legacy?.profile ?? profiles.active;
  if (!profiles.profiles[profileName]) {
    throw codedError("profile_not_found");
  }

  const destination = profileConfigPath(profileName, configDir);
  const profileConfig = await loadConfig(destination);
  const legacyBelongsToProfile = Boolean(
    legacy && (
      legacy.profile === profileName ||
      (!legacy.profile && profileName === profiles.active)
    ),
  );

  if (profileConfig) {
    if (
      legacyBelongsToProfile &&
      !binding &&
      options.profileName === undefined &&
      !configsMatch(profileConfig, legacy!, profileName)
    ) {
      throw codedError("sync_config_ambiguous");
    }
    if (options.profileName === undefined) {
      await writeBinding(configDir, profileName);
    }
    return {
      config: normalizedConfig(profileConfig, profileName),
      profileName,
      configPath: destination,
      source: "profile",
    };
  }

  if (!legacy || !legacyBelongsToProfile) {
    return null;
  }

  const migrated = await migrateLegacyConfig(configDir, profileName, legacy);
  if (options.profileName === undefined) await writeBinding(configDir, profileName);
  return {
    config: migrated,
    profileName,
    configPath: destination,
    source: "legacy_migrated",
  };
}

export async function saveProfileSyncConfig(
  config: SyncConfig,
  options: ProfileSyncConfigOptions & { bindDaemon?: boolean } = {},
): Promise<void> {
  const configDir = options.configDir ?? defaultConfigDir();
  const profiles = await loadProfiles({ configDir, migrateLegacyFiles: false });
  const profileName = options.profileName ?? config.profile ?? profiles.active;
  if (!profiles.profiles[profileName]) {
    throw codedError("profile_not_found");
  }
  const parsed = normalizedConfig(config, profileName);
  const destination = profileConfigPath(profileName, configDir);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(destination, JSON.stringify(parsed, null, 2), 0o600);
  if (options.bindDaemon !== false) await writeBinding(configDir, profileName);
}
