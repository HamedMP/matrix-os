import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatElectronPreviewRequest } from "./transport";

const CLAIM_NAME = /^[a-f0-9]{64}$/;
const CLAIM_TTL = 24 * 60 * 60 * 1000;
const MAX_CLAIMS = 512;

export function previewRequestKey(request: ChatElectronPreviewRequest): string {
  const scope = [request.scopeKey, request.chatId, request.runId];
  if (request.requestKind === "verification") {
    scope.push(request.requestKind, request.projectId, request.worktreeId, request.baseSha, request.sourceSha256);
  }
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function createChatElectronPreviewClaims(directory: string) {
  function claimPath(key: string): string {
    if (!CLAIM_NAME.test(key)) throw new Error("invalid preview claim");
    return join(directory, key);
  }

  return {
    async wasHandled(key: string) {
      try {
        return (await lstat(claimPath(key))).isFile();
      } catch (error: unknown) {
        if (!missing(error)) throw error;
        return false;
      }
    },
    async claim(key: string) {
      const path = claimPath(key);
      await mkdir(directory, { mode: 0o700, recursive: true });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) throw new Error("unsafe preview claims directory");
      const entries = await readdir(directory, { withFileTypes: true });
      let remaining = entries.length;
      const expired = Date.now() - CLAIM_TTL;
      for (const entry of entries) {
        if (!entry.isFile() || !CLAIM_NAME.test(entry.name)) continue;
        const candidate = join(directory, entry.name);
        const info = await lstat(candidate);
        if (info.isFile() && info.mtimeMs < expired) {
          await unlink(candidate);
          remaining--;
        }
      }
      if (remaining >= MAX_CLAIMS) throw new Error("preview claim capacity reached");
      try {
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
        return false;
      }
    },
  };
}
