import { randomBytes } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import type { BrowserLogin } from "./chromium-secrets";

/** User-selected, plaintext, portable export. The renderer never sees contents or path. */
export async function exportBrowserPasswords(
  vault: Pick<{ all(): Promise<BrowserLogin[]> }, "all">,
  chooseDestination: () => Promise<string | null>,
  ensureAuthorized?: () => void,
): Promise<boolean> {
  const destination = await chooseDestination();
  if (!destination) return false;
  const temporary = `${destination}.matrix-${randomBytes(8).toString("hex")}.tmp`;
  try {
    ensureAuthorized?.();
    const payload = JSON.stringify({ version: 1, logins: await vault.all() }, null, 2);
    if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new Error("export too large");
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Hard-link creation is exclusive; an existing destination is never replaced.
    ensureAuthorized?.();
    await link(temporary, destination);
    return true;
  } catch {
    throw new Error("password export unavailable");
  } finally {
    await rm(temporary, { force: true });
  }
}
