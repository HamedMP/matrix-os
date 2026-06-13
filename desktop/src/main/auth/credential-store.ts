// OS-encrypted credential persistence (FR-002). Electron safeStorage uses the
// macOS Keychain-backed encryption key; the blob lives in userData. The
// credential never crosses the IPC boundary.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface StoredCredential {
  accessToken: string;
  expiresAt: number;
  userId: string;
  handle: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface CredentialStore {
  save(credential: StoredCredential): Promise<void>;
  load(): Promise<StoredCredential | null>;
  clear(): Promise<void>;
}

export function createCredentialStore(options: {
  dir: string;
  safeStorage: SafeStorageLike;
}): CredentialStore {
  const filePath = join(options.dir, "credential.bin");

  return {
    async save(credential) {
      if (!options.safeStorage.isEncryptionAvailable()) {
        throw new Error("OS encryption unavailable; refusing to store credential in plain text");
      }
      await mkdir(options.dir, { recursive: true });
      const encrypted = options.safeStorage.encryptString(JSON.stringify(credential));
      const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmpPath, encrypted);
      await rename(tmpPath, filePath);
    },

    async load() {
      let blob: Buffer;
      try {
        blob = await readFile(filePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        console.warn(
          "[credential-store] failed to read credential:",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(options.safeStorage.decryptString(blob));
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as StoredCredential).accessToken === "string" &&
          typeof (parsed as StoredCredential).expiresAt === "number" &&
          typeof (parsed as StoredCredential).userId === "string" &&
          typeof (parsed as StoredCredential).handle === "string"
        ) {
          return parsed as StoredCredential;
        }
      } catch (err: unknown) {
        // Decryption fails after OS keychain resets; treat as signed out.
        console.warn(
          "[credential-store] failed to decrypt credential, treating as signed out:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    },

    async clear() {
      await rm(filePath, { force: true });
    },
  };
}
