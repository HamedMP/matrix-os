import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { SafeStorageLike } from "../auth/credential-store";

const MAX_KEY_BYTES = 4096;
const TEMP_SWEEP_INTERVAL_MS = 60_000;
const TEMP_WRITE_GRACE_MS = 60 * 60_000;
const MAX_TEMP_SWEEP_ENTRIES = 256;
const TEMP_FILE = /^device-[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/;
const SavedKey = z.strictObject({
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
});

interface KeyScope { origin: string; ownerId: string }

export type PairingSafeStorage = SafeStorageLike & { getSelectedStorageBackend?(): string };

function identifyPairingKey(privateKey: KeyObject) {
  const publicBytes = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    privateKey,
    publicKey: publicBytes.toString("base64url"),
    deviceId: createHash("sha256").update(publicBytes).digest("hex"),
  };
}

export function createPairingKeyStore(userData: string, safeStorage: PairingSafeStorage) {
  const directory = join(userData, "desktop-pairing");
  let lastSweep = -Infinity;
  let sweeping = false;
  let disposed = false;
  let activeWrites = 0;
  const timer = setInterval(() => {
    void sweepTempFiles().catch((error: unknown) => {
      console.warn("[desktop-pairing] key cleanup failed", error instanceof Error ? "filesystem error" : "unexpected error");
    });
  }, TEMP_SWEEP_INTERVAL_MS);
  timer.unref();

  function checkEncryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("Key protection unavailable");
    }
  }

  function files(scope: KeyScope) {
    const id = createHash("sha256").update(JSON.stringify([scope.ownerId, scope.origin])).digest("hex");
    return { id, path: join(directory, `device-${id}.bin`) };
  }

  async function inspectDirectory() {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Invalid pairing directory");
      return info;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function sweepTempFiles() {
    const now = Date.now();
    if (disposed || sweeping || activeWrites > 0 || now - lastSweep < TEMP_SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    sweeping = true;
    try {
      const parent = await inspectDirectory();
      if (!parent) return;
      const entries = await opendir(directory);
      let visited = 0;
      for await (const entry of entries) {
        if (++visited > MAX_TEMP_SWEEP_ENTRIES || disposed || activeWrites > 0) break;
        if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const info = await lstat(path);
          if (!info.isFile() || now - info.mtimeMs <= TEMP_WRITE_GRACE_MS) continue;
          const current = await inspectDirectory();
          if (current?.dev !== parent.dev || current.ino !== parent.ino || disposed || activeWrites > 0) break;
          await rm(path, { force: true });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } finally {
      sweeping = false;
    }
  }

  async function load(scope: KeyScope) {
    if (!await inspectDirectory()) return null;
    await sweepTempFiles();
    const { id, path } = files(scope);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > MAX_KEY_BYTES) {
        throw new Error("Invalid pairing key file");
      }
      checkEncryption();
      const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error("Pairing key changed");
      const saved = SavedKey.parse(JSON.parse(safeStorage.decryptString(bytes.subarray(0, bytesRead))));
      if (saved.scope !== id) throw new Error("Pairing key scope mismatch");
      const privateKey = createPrivateKey({ key: Buffer.from(saved.privateKey, "base64url"), type: "pkcs8", format: "der" });
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid pairing key type");
      return identifyPairingKey(privateKey);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function loadOrCreate(scope: KeyScope, signal: AbortSignal) {
    signal.throwIfAborted();
    const existing = await load(scope);
    signal.throwIfAborted();
    if (existing) return existing;
    checkEncryption();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!await inspectDirectory()) throw new Error("Pairing directory unavailable");
    await sweepTempFiles();
    signal.throwIfAborted();

    const { privateKey } = generateKeyPairSync("ed25519");
    const { id, path } = files(scope);
    const saved = {
      scope: id,
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(saved));
    if (encrypted.length > MAX_KEY_BYTES) throw new Error("Invalid encrypted key size");
    const temporary = `${path}.${randomUUID()}.tmp`;
    activeWrites++;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(encrypted);
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
        // Publish complete bytes atomically. Another process cannot replace our
        // key and invalidate a challenge that we just signed.
        try {
          await link(temporary, path);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const winner = await load(scope);
          if (winner) return winner;
          throw error;
        }
        return identifyPairingKey(privateKey);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      activeWrites--;
    }
  }

  return {
    load,
    loadOrCreate,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
