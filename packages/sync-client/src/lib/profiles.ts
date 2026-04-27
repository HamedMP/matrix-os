import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { DEFAULT_GATEWAY_URL, DEFAULT_PLATFORM_URL } from "./config.js";

const PROFILE_SLUG = /^[a-z][a-z0-9-]{0,30}$/;

export const ProfileSchema = z.object({
  platformUrl: z.url(),
  gatewayUrl: z.url(),
});

export const ProfilesFileSchema = z.object({
  active: z.string().regex(PROFILE_SLUG),
  profiles: z.record(z.string().regex(PROFILE_SLUG), ProfileSchema),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

export interface LoadProfilesOptions {
  configDir?: string;
}

function defaultConfigDir(): string {
  return join(homedir(), ".matrixos");
}

export function profilePath(name: string, configDir = defaultConfigDir()): string {
  if (!PROFILE_SLUG.test(name)) {
    throw new Error("invalid_profile_name");
  }
  return join(configDir, "profiles", name);
}

export function profileAuthPath(name: string, configDir = defaultConfigDir()): string {
  return join(profilePath(name, configDir), "auth.json");
}

export function profileConfigPath(name: string, configDir = defaultConfigDir()): string {
  return join(profilePath(name, configDir), "config.json");
}

function defaultProfiles(): ProfilesFile {
  return {
    active: "cloud",
    profiles: {
      cloud: {
        platformUrl: DEFAULT_PLATFORM_URL,
        gatewayUrl: DEFAULT_GATEWAY_URL,
      },
      local: {
        platformUrl: "http://localhost:9000",
        gatewayUrl: "http://localhost:4000",
      },
    },
  };
}

export async function loadProfiles(
  options: LoadProfilesOptions = {},
): Promise<ProfilesFile> {
  const configDir = options.configDir ?? defaultConfigDir();
  const profilesPath = join(configDir, "profiles.json");
  let profiles: ProfilesFile;

  try {
    profiles = ProfilesFileSchema.parse(
      JSON.parse(await readFile(profilesPath, "utf-8")),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      profiles = defaultProfiles();
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeUtf8FileAtomic(profilesPath, JSON.stringify(profiles, null, 2), 0o600);
    } else {
      throw err;
    }
  }

  await migrateLegacyProfileFiles(configDir);
  return profiles;
}

export async function saveProfiles(
  profiles: ProfilesFile,
  configDir = defaultConfigDir(),
): Promise<void> {
  const parsed = ProfilesFileSchema.parse(profiles);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(join(configDir, "profiles.json"), JSON.stringify(parsed, null, 2), 0o600);
}

export async function setActiveProfile(
  name: string,
  configDir = defaultConfigDir(),
): Promise<ProfilesFile> {
  const profiles = await loadProfiles({ configDir });
  if (!profiles.profiles[name]) {
    throw new Error("profile_not_found");
  }
  const next = { ...profiles, active: name };
  await saveProfiles(next, configDir);
  return next;
}

async function migrateLegacyProfileFiles(configDir: string): Promise<void> {
  await moveIfPresent(join(configDir, "auth.json"), profileAuthPath("cloud", configDir));
  await moveIfPresent(join(configDir, "config.json"), profileConfigPath("cloud", configDir));
}

async function moveIfPresent(from: string, to: string): Promise<void> {
  try {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await rename(from, to);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      ((err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "EEXIST")
    ) {
      return;
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      const raw = await readFile(from, "utf-8");
      await writeFile(to, raw, { flag: "wx", mode: 0o600 });
      await import("node:fs/promises").then(({ unlink }) => unlink(from));
      return;
    }
    throw err;
  }
}
