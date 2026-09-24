import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BrowserPasswordVault } from "./password-vault";

/** Stable, path-safe local storage names for one authenticated Matrix account. */
export function browserAccountScope(userId: string): { partition: string; vaultDirectory: string } {
  if (!userId || userId.length > 512) throw new Error("browser account unavailable");
  const digest = createHash("sha256").update(userId).digest("hex");
  return {
    partition: `persist:browser-${digest}`,
    vaultDirectory: join("browser-accounts", digest),
  };
}

/** Check ownership again after I/O, because sign-out can occur while a read is pending. */
export function bindBrowserVaultToAccount(
  ownerId: string,
  currentUserId: () => string,
  vault: BrowserPasswordVault,
): BrowserPasswordVault {
  const verify = () => {
    if (currentUserId() !== ownerId) throw new Error("browser account unavailable");
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    verify();
    const result = await operation();
    verify();
    return result;
  };
  return {
    list: () => run(() => vault.list()),
    all: () => run(() => vault.all()),
    find: (origin, username) => run(() => vault.find(origin, username)),
    upsertMany: (logins) => run(() => vault.upsertMany(logins)),
    remove: (origin, username) => run(() => vault.remove(origin, username)),
  };
}
