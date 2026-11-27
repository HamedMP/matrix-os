import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopPairingDeviceIdSchema, DesktopPairingStateSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { SafeStorageLike } from "../auth/credential-store";
import { matchingPairingState, type PairingState } from "./transport";

const MAX_FILE_BYTES = 4096;
const TEMP_SWEEP_INTERVAL_MS = 60_000;
const TEMP_WRITE_GRACE_MS = 60 * 60_000;
const MAX_TEMP_SWEEP_ENTRIES = 256;
const TEMP_FILE = /^(?:device|chat-full-access|desktop-link-full-access)-[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/;
const ScopeId = z.string().regex(/^[a-f0-9]{64}$/);
const SavedKey = z.strictObject({
  scope: ScopeId,
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
});
/** The owner's Full Access for the desktop link on this device (spec 2716, D2), bound to one pairing. */
const SavedLinkFullAccess = DesktopPairingStateSchema.extend({
  scope: ScopeId,
  deviceId: DesktopPairingDeviceIdSchema,
  capability: z.literal("desktop-link"),
});

export interface KeyScope { origin: string; ownerId: string }

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
    return {
      id, keyPath: join(directory, `device-${id}.bin`),
      linkFullAccessPath: join(directory, `desktop-link-full-access-${id}.bin`),
    };
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

  async function readEncryptedRecord(path: string): Promise<unknown> {
    if (!await inspectDirectory()) return null;
    await sweepTempFiles();
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > MAX_FILE_BYTES) {
        throw new Error("Invalid pairing file");
      }
      checkEncryption();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error("Pairing file changed");
      return JSON.parse(safeStorage.decryptString(bytes.subarray(0, bytesRead))) as unknown;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function load(scope: KeyScope) {
    const { id, keyPath } = files(scope);
    const record = await readEncryptedRecord(keyPath);
    if (record === null) return null;
    const saved = SavedKey.parse(record);
    if (saved.scope !== id) throw new Error("Pairing key scope mismatch");
    const privateKey = createPrivateKey({ key: Buffer.from(saved.privateKey, "base64url"), type: "pkcs8", format: "der" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid pairing key type");
    return identifyPairingKey(privateKey);
  }

  async function publishEncryptedRecord(
    path: string, record: object, signal: AbortSignal, publish: (temporary: string) => Promise<void>,
  ) {
    signal.throwIfAborted();
    checkEncryption();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!await inspectDirectory()) throw new Error("Pairing directory unavailable");
    await sweepTempFiles();
    signal.throwIfAborted();

    const encrypted = safeStorage.encryptString(JSON.stringify(record));
    if (encrypted.length === 0 || encrypted.length > MAX_FILE_BYTES) throw new Error("Invalid encrypted record size");
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
        await publish(temporary);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      activeWrites--;
    }
  }

  async function loadOrCreate(scope: KeyScope, signal: AbortSignal) {
    signal.throwIfAborted();
    const existing = await load(scope);
    signal.throwIfAborted();
    if (existing) return existing;
    const { privateKey } = generateKeyPairSync("ed25519");
    const { id, keyPath } = files(scope);
    const saved = {
      scope: id,
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    };
    try {
      // Publish complete bytes without replacing a key used by another process.
      await publishEncryptedRecord(keyPath, saved, signal, temporary => link(temporary, keyPath));
      return identifyPairingKey(privateKey);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await load(scope);
      if (winner) return winner;
      throw error;
    }
  }

  async function hasLinkFullAccess(scope: KeyScope, state: PairingState) {
    if (!state.deviceId) return false;
    const { id, linkFullAccessPath } = files(scope);
    const record = await readEncryptedRecord(linkFullAccessPath);
    if (record === null) return false;
    const saved = SavedLinkFullAccess.parse(record);
    return saved.scope === id && matchingPairingState(state, saved);
  }

  async function allowLinkFullAccess(scope: KeyScope, state: PairingState, signal: AbortSignal, assertCurrent: () => void) {
    const { id, linkFullAccessPath } = files(scope);
    const saved = SavedLinkFullAccess.parse({ ...state, scope: id, capability: "desktop-link" });
    await publishEncryptedRecord(linkFullAccessPath, saved, signal, temporary => {
      assertCurrent();
      return rename(temporary, linkFullAccessPath);
    });
  }

  async function revokeLinkFullAccess(scope: KeyScope) {
    if (!await inspectDirectory()) return;
    await rm(files(scope).linkFullAccessPath, { force: true });
  }

  return {
    load,
    loadOrCreate,
    hasLinkFullAccess,
    allowLinkFullAccess,
    revokeLinkFullAccess,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
