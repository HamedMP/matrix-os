import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, platform as hostPlatform } from "node:os";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "../lib/atomic-write.js";
import { profileAuthPath } from "../lib/profiles.js";
import { AuthDataSchema, type AuthData } from "./schema.js";
import {
  createMacKeychainAuthStore,
  type MacKeychainAuthStore,
} from "./macos-keychain.js";

export { AuthDataSchema, type AuthData } from "./schema.js";

export const MacKeychainAuthReferenceSchema = z.object({
  schemaVersion: z.literal(1),
  credentialStore: z.literal("macos-keychain"),
  account: z.uuid(),
}).strict();
export type MacKeychainAuthReference = z.infer<typeof MacKeychainAuthReferenceSchema>;

export interface AuthStoreOptions {
  platform?: NodeJS.Platform;
  keychain?: MacKeychainAuthStore;
  randomId?: () => string;
}

function authFilePath(): string {
  return join(homedir(), ".matrixos", "auth.json");
}

export function authFilePathForProfile(
  profileName: string,
  configDir?: string,
): string {
  return profileAuthPath(profileName, configDir);
}

function keychainStore(options: AuthStoreOptions): MacKeychainAuthStore {
  return options.keychain ?? createMacKeychainAuthStore();
}

async function readStoredAuth(filePath: string): Promise<AuthData | MacKeychainAuthReference | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const reference = MacKeychainAuthReferenceSchema.safeParse(parsed);
    return reference.success ? reference.data : AuthDataSchema.parse(parsed);
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

export async function loadAuth(
  path?: string,
  options: AuthStoreOptions = {},
): Promise<AuthData | null> {
  const stored = await readStoredAuth(path ?? authFilePath());
  if (!stored) return null;
  if (!("credentialStore" in stored)) return stored;
  if ((options.platform ?? hostPlatform()) !== "darwin") {
    throw new Error("macOS Keychain credential is unavailable on this platform");
  }
  return keychainStore(options).get(stored.account);
}

export async function saveAuth(
  data: AuthData,
  path?: string,
  options: AuthStoreOptions = {},
): Promise<void> {
  const filePath = path ?? authFilePath();
  const existing = await readStoredAuth(filePath);
  if (existing && "credentialStore" in existing) {
    if ((options.platform ?? hostPlatform()) !== "darwin") {
      throw new Error("macOS Keychain credential is unavailable on this platform");
    }
    await keychainStore(options).set(existing.account, AuthDataSchema.parse(data));
    return;
  }
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(filePath, JSON.stringify(data, null, 2), 0o600);
}

export async function saveAuthToMacKeychain(
  data: AuthData,
  path?: string,
  options: AuthStoreOptions = {},
): Promise<void> {
  if ((options.platform ?? hostPlatform()) !== "darwin") {
    throw new Error("macOS Keychain is required for Desktop sync enrollment");
  }
  const filePath = path ?? authFilePath();
  const existing = await readStoredAuth(filePath);
  if (existing && "credentialStore" in existing) {
    await keychainStore(options).set(existing.account, AuthDataSchema.parse(data));
    return;
  }
  const account = (options.randomId ?? randomUUID)();
  const reference = MacKeychainAuthReferenceSchema.parse({
    schemaVersion: 1,
    credentialStore: "macos-keychain",
    account,
  });
  const keychain = keychainStore(options);
  await keychain.set(account, AuthDataSchema.parse(data));
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeUtf8FileAtomic(filePath, JSON.stringify(reference, null, 2), 0o600);
  } catch (err: unknown) {
    await keychain.delete(account).catch(() => undefined);
    throw err;
  }
}

export async function clearAuth(
  path?: string,
  options: AuthStoreOptions = {},
): Promise<void> {
  const filePath = path ?? authFilePath();
  const existing = await readStoredAuth(filePath);
  if (existing && "credentialStore" in existing) {
    if ((options.platform ?? hostPlatform()) !== "darwin") {
      throw new Error("macOS Keychain credential is unavailable on this platform");
    }
    await keychainStore(options).delete(existing.account);
  }
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
  options?: AuthStoreOptions,
): Promise<AuthData | null> {
  return loadAuth(authFilePathForProfile(profileName, configDir), options);
}

export function saveProfileAuth(
  profileName: string,
  data: AuthData,
  configDir?: string,
  options?: AuthStoreOptions,
): Promise<void> {
  return saveAuth(data, authFilePathForProfile(profileName, configDir), options);
}

export function saveProfileAuthToMacKeychain(
  profileName: string,
  data: AuthData,
  configDir?: string,
  options?: AuthStoreOptions,
): Promise<void> {
  return saveAuthToMacKeychain(data, authFilePathForProfile(profileName, configDir), options);
}

export function clearProfileAuth(
  profileName: string,
  configDir?: string,
  options?: AuthStoreOptions,
): Promise<void> {
  return clearAuth(authFilePathForProfile(profileName, configDir), options);
}

export function isExpired(auth: AuthData): boolean {
  return Date.now() >= auth.expiresAt;
}
