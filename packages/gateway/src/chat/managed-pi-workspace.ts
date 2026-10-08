import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { ChatExecutionRootError } from "./execution-root.js";

/** Root Chats get a narrow server-owned directory, never the owner's entire home. */
export async function managedPiWorkspace(homePath: string, ownerId: string, chatId: string, create = false): Promise<{ path: string; fingerprint: string }> {
  CanonicalChatIdSchema.parse(chatId);
  const home = resolve(homePath);
  const ownerKey = createHash("sha256").update(ownerId).digest("hex");
  let path = home;
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new ChatExecutionRootError("invalid_root");
  for (const segment of ["agent-workspaces", ownerKey, chatId]) {
    path = join(path, segment);
    if (create) await mkdir(path, { mode: 0o750 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ChatExecutionRootError("invalid_root");
  }
  const info = await lstat(path, { bigint: true });
  const fingerprint = createHash("sha256").update(JSON.stringify({ ownerId, chatId, path, dev: info.dev.toString(), ino: info.ino.toString() })).digest("hex");
  return { path, fingerprint };
}
