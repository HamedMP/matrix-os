import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SafeStorageLike } from "../auth/credential-store";
import type { BrowserLogin } from "./chromium-secrets";

const MAX_PASSWORDS = 10_000;
const MAX_VAULT_BYTES = 8 * 1024 * 1024;

export interface BrowserPasswordVault {
  list(): Promise<Array<Pick<BrowserLogin, "origin" | "username">>>;
  all(): Promise<BrowserLogin[]>;
  find(origin: string, username: string): Promise<BrowserLogin | null>;
  upsertMany(logins: BrowserLogin[]): Promise<number>;
  remove(origin: string, username: string): Promise<boolean>;
}

function validLogin(value: unknown): value is BrowserLogin {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrowserLogin>;
  if (typeof item.origin !== "string" || typeof item.username !== "string" || typeof item.password !== "string" ||
    !item.username || item.username.length > 512 || !item.password || item.password.length > 64 * 1024) return false;
  try {
    const url = new URL(item.origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === item.origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A local, OS-encrypted browser vault. Passwords never enter renderer IPC. */
export function createBrowserPasswordVault(options: {
  dir: string;
  safeStorage: SafeStorageLike & { getSelectedStorageBackend?(): string };
}): BrowserPasswordVault {
  const file = join(options.dir, "browser-passwords.bin");
  let mutation = Promise.resolve();

  function hasOsEncryption(): boolean {
    return options.safeStorage.isEncryptionAvailable() &&
      options.safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  }

  async function load(): Promise<BrowserLogin[]> {
    let size: number;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT_BYTES) throw new Error("invalid vault file");
      size = stat.size;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("browser password vault unavailable");
    }
    if (!hasOsEncryption()) {
      throw new Error("browser password vault unavailable");
    }
    let blob: Buffer;
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > MAX_VAULT_BYTES || current.size !== size) throw new Error("invalid vault file");
        const chunks: Buffer[] = [];
        let bytes = 0;
        let position = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) break;
          bytes += bytesRead;
          if (bytes > MAX_VAULT_BYTES) throw new Error("vault too large");
          position += bytesRead;
          chunks.push(chunk.subarray(0, bytesRead));
        }
        blob = Buffer.concat(chunks, bytes);
      } finally {
        await handle.close();
      }
      const value: unknown = JSON.parse(options.safeStorage.decryptString(blob));
      if (!Array.isArray(value) || value.length > MAX_PASSWORDS || !value.every(validLogin)) throw new Error("invalid vault");
      return value;
    } catch {
      throw new Error("browser password vault unavailable");
    }
  }

  async function persist(logins: BrowserLogin[]): Promise<void> {
    const encrypted = options.safeStorage.encryptString(JSON.stringify(logins));
    if (encrypted.length > MAX_VAULT_BYTES) throw new Error("browser password vault full");
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    async list() {
      await mutation;
      return (await load()).map(({ origin, username }) => ({ origin, username }));
    },
    async all() {
      await mutation;
      return load();
    },
    async find(origin, username) {
      await mutation;
      return (await load()).find((item) => item.origin === origin && item.username === username) ?? null;
    },
    upsertMany(logins) {
      const result = mutation.then(async () => {
        if (!hasOsEncryption()) throw new Error("OS encryption unavailable");
        if (logins.length > MAX_PASSWORDS || !logins.every(validLogin)) throw new Error("invalid browser passwords");
        const existing = await load();
        const map = new Map(existing.map((item) => [`${item.origin}\0${item.username}`, item]));
        for (const item of logins) map.set(`${item.origin}\0${item.username}`, item);
        if (map.size > MAX_PASSWORDS) throw new Error("browser password vault full");
        await persist([...map.values()]);
        return logins.length;
      });
      mutation = result.then(() => undefined, () => undefined);
      return result;
    },
    remove(origin, username) {
      const result = mutation.then(async () => {
        if (!hasOsEncryption()) throw new Error("OS encryption unavailable");
        const existing = await load();
        const remaining = existing.filter((item) => item.origin !== origin || item.username !== username);
        if (remaining.length === existing.length) return false;
        await persist(remaining);
        return true;
      });
      mutation = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
