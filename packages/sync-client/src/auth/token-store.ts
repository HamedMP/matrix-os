import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "../lib/atomic-write.js";
import { profileAuthPath } from "../lib/profiles.js";

export const AuthDataSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().nonnegative(),
  userId: z.string().min(1),
  handle: z.string().min(1),
});

export type AuthData = z.infer<typeof AuthDataSchema>;

function authFilePath(): string {
  return join(homedir(), ".matrixos", "auth.json");
}

export function authFilePathForProfile(
  profileName: string,
  configDir?: string,
): string {
  return profileAuthPath(profileName, configDir);
}

export async function loadAuth(path?: string): Promise<AuthData | null> {
  const filePath = path ?? authFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return AuthDataSchema.parse(parsed);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function saveAuth(
  data: AuthData,
  path?: string,
): Promise<void> {
  const filePath = path ?? authFilePath();
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(filePath, JSON.stringify(data, null, 2), 0o600);
}

export async function clearAuth(path?: string): Promise<void> {
  const filePath = path ?? authFilePath();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

export function loadProfileAuth(
  profileName: string,
  configDir?: string,
): Promise<AuthData | null> {
  return loadAuth(authFilePathForProfile(profileName, configDir));
}

export function saveProfileAuth(
  profileName: string,
  data: AuthData,
  configDir?: string,
): Promise<void> {
  return saveAuth(data, authFilePathForProfile(profileName, configDir));
}

export function clearProfileAuth(
  profileName: string,
  configDir?: string,
): Promise<void> {
  return clearAuth(authFilePathForProfile(profileName, configDir));
}

export function isExpired(auth: AuthData): boolean {
  return Date.now() >= auth.expiresAt;
}
