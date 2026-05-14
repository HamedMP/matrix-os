import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SymphonyCredentialStore {
  hasLinearCredential(ownerId: string): Promise<boolean>;
  readLinearCredential(ownerId: string): Promise<string | null>;
  writeLinearCredential(ownerId: string, secret: string): Promise<void>;
  deleteLinearCredential(ownerId: string): Promise<void>;
}

const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

function assertOwnerId(ownerId: string): void {
  if (!OWNER_ID_RE.test(ownerId)) {
    throw new Error("Invalid owner identifier");
  }
}

function credentialPath(homePath: string, ownerId: string): string {
  assertOwnerId(ownerId);
  return join(homePath, "system", "symphony", "credentials", `${ownerId}.linear`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function createFileSymphonyCredentialStore(options: { homePath: string }): SymphonyCredentialStore {
  const homePath = resolve(options.homePath);

  return {
    async hasLinearCredential(ownerId: string): Promise<boolean> {
      return pathExists(credentialPath(homePath, ownerId));
    },

    async readLinearCredential(ownerId: string): Promise<string | null> {
      const path = credentialPath(homePath, ownerId);
      try {
        const secret = await readFile(path, "utf8");
        const trimmed = secret.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async writeLinearCredential(ownerId: string, secret: string): Promise<void> {
      const path = credentialPath(homePath, ownerId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700).catch((err: unknown) => {
        console.warn("[symphony] Credential directory chmod failed:", err instanceof Error ? err.message : String(err));
      });
      const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, `${secret.trim()}\n`, { flag: "wx", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
        await chmod(path, 0o600);
      } catch (err: unknown) {
        await rm(tmp, { force: true }).catch((cleanupErr: unknown) => {
          console.warn("[symphony] Credential temp cleanup failed:", cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
        });
        throw err;
      }
    },

    async deleteLinearCredential(ownerId: string): Promise<void> {
      await rm(credentialPath(homePath, ownerId), { force: true });
    },
  };
}
