import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE_OWNER_ID = /^[A-Za-z0-9_@:.=-]+$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._:-]+$/;

export interface HermesCredentialStore {
  hasModelCredential(ownerId: string, providerId: string): Promise<boolean>;
  readModelCredential(ownerId: string, providerId: string): Promise<string | null>;
  writeModelCredential(ownerId: string, providerId: string, secret: string): Promise<void>;
  deleteModelCredential(ownerId: string, providerId: string): Promise<void>;
  publicMetadata(ownerId: string, providerId: string): Promise<{ configured: boolean; providerId: string }>;
}

export interface FileHermesCredentialStoreOptions {
  homePath: string;
}

function assertSafe(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function credentialPath(homePath: string, ownerId: string, providerId: string): string {
  const safeOwner = assertSafe(ownerId, SAFE_OWNER_ID, "owner identifier");
  const safeProvider = assertSafe(providerId, SAFE_PROVIDER_ID, "provider identifier");
  const ownerHash = createHash("sha256").update(safeOwner, "utf8").digest("hex");
  const providerHash = createHash("sha256").update(safeProvider, "utf8").digest("hex");
  return join(homePath, "system", "hermes-manager", "credentials", `${ownerHash}.${providerHash}`);
}

export function createFileHermesCredentialStore(options: FileHermesCredentialStoreOptions): HermesCredentialStore {
  return {
    async hasModelCredential(ownerId, providerId) {
      try {
        await stat(credentialPath(options.homePath, ownerId, providerId));
        return true;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
        throw err;
      }
    },

    async readModelCredential(ownerId, providerId) {
      try {
        return await readFile(credentialPath(options.homePath, ownerId, providerId), "utf8");
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      }
    },

    async writeModelCredential(ownerId, providerId, secret) {
      const finalPath = credentialPath(options.homePath, ownerId, providerId);
      const dir = join(options.homePath, "system", "hermes-manager", "credentials");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tempPath = join(dir, `.tmp-${randomUUID()}`);
      try {
        await writeFile(tempPath, secret, { mode: 0o600, flag: "wx" });
        await rename(tempPath, finalPath);
      } catch (err: unknown) {
        await rm(tempPath, { force: true }).catch((cleanupErr: unknown) => {
          console.warn("[hermes] Failed to clean temporary credential file:", cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
        });
        throw err;
      }
    },

    async deleteModelCredential(ownerId, providerId) {
      await rm(credentialPath(options.homePath, ownerId, providerId), { force: true });
    },

    async publicMetadata(ownerId, providerId) {
      return { configured: await this.hasModelCredential(ownerId, providerId), providerId };
    },
  };
}
