import { parseMailDeviceCache } from "@matrix-os/contracts";
import type { EditionDownloadHost } from "../../../../home/app-templates/connected-starter/src/edition/runtime";
export interface EditionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface EditionComputer {
  handle: string;
  runtimeSlot: string;
  gatewayPath: string;
}
const ACTIVE = "matrix-edition-device-active";
const PREFIX = "matrix-edition-device-v1:";
// All owner-switch and device writes share one bounded slot; no credentials are persisted.
let tail: Promise<unknown> = Promise.resolve(),
  waiting = 0;
function serial<T>(operation: () => Promise<T>): Promise<T> {
  if (waiting >= 32)
    return Promise.reject(new Error("Edition device storage busy"));
  waiting++;
  const result = tail.then(operation, operation);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    waiting--;
  });
}
export async function clearNativeEditionOwner(
  storage: EditionStorage,
  ownerId: string | null,
) {
  await serial(async () => {
    const pointer = await storage.getItem(ACTIVE);
    if (!pointer) return;
    let entry: { ownerId?: unknown; key?: unknown };
    try {
      const value: unknown = JSON.parse(pointer);
      entry = value && typeof value === "object" ? value : {};
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await storage.removeItem(ACTIVE);
      return;
    }
    if (entry.ownerId === ownerId) return;
    if (
      typeof entry.key === "string" &&
      entry.key.startsWith(PREFIX) &&
      entry.key.length < 2048
    )
      await storage.removeItem(entry.key);
    await storage.removeItem(ACTIVE);
  });
}
export function createNativeEditionDownloads(options: {
  ownerId: string;
  computer: EditionComputer;
  storage: EditionStorage;
  isCurrent(): boolean;
}): EditionDownloadHost {
  const { ownerId, computer, storage, isCurrent } = options;
  const scope = JSON.stringify([
    ownerId,
    computer.handle,
    computer.runtimeSlot,
  ]);
  if (!ownerId || scope.length > 512)
    throw new Error("Reading identity unavailable");
  const key = PREFIX + encodeURIComponent(scope);
  const check = () => {
    if (!isCurrent()) throw new Error("Reading session changed");
  };
  return {
    load: () =>
      serial(async () => {
        check();
        const pointer = await storage.getItem(ACTIVE);
        check();
        if (pointer) {
          let old: { key?: unknown };
          try {
            const value: unknown = JSON.parse(pointer);
            old = value && typeof value === "object" ? value : {};
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            old = {};
          }
          if (
            typeof old.key === "string" &&
            old.key !== key &&
            old.key.startsWith(PREFIX) &&
            old.key.length < 2048
          )
            await storage.removeItem(old.key);
        }
        check();
        await storage.setItem(ACTIVE, JSON.stringify({ ownerId, key }));
        const raw = await storage.getItem(key);
        check();
        if (raw) {
          try {
            parseMailDeviceCache(raw);
          } catch {
            console.warn("Edition device copy unavailable");
            await storage.removeItem(key);
            return { scope, raw: null };
          }
        }
        return { scope, raw };
      }),
    save: (raw) =>
      serial(async () => {
        check();
        parseMailDeviceCache(raw);
        await storage.setItem(key, raw);
        check();
      }),
    clear: () =>
      serial(async () => {
        await storage.removeItem(key);
      }),
  };
}
