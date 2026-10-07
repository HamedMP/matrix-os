import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";

const MAX_BYTES = 256 * 1024;
const AuthSchema = z.object({ auth_mode: z.literal("chatgpt").optional(), tokens: z.object({
  access_token: z.string().min(1).max(64 * 1024),
  refresh_token: z.string().min(1).max(64 * 1024),
}) });

/** Private equality evidence only; bind solely after effective file-backend confirmation. */
export function createCodexCredentialFileProofReader(input: { homePath: string; codexHome?: string }) {
  const selected = resolve(input.homePath, input.codexHome ?? ".codex");
  const key = randomBytes(32);
  return async (): Promise<string | null> => {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) return null;
      const canonical = await realpath(selected);
      for (const start of [selected, canonical]) {
        for (let ancestor = start; ; ancestor = dirname(ancestor)) {
          const info = await lstat(ancestor);
          const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
          if ((!info.isDirectory() && !info.isSymbolicLink()) || ![0, uid].includes(info.uid)
            || !info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !stickyRoot) return null;
          if ((ancestor === selected || ancestor === canonical) && (info.uid !== uid || info.isSymbolicLink())) return null;
          if (dirname(ancestor) === ancestor) break;
        }
      }
      const path = join(canonical, "auth.json");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o077) !== 0) return null;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || info.size < 2 || info.size > MAX_BYTES
          || info.ino !== before.ino || info.dev !== before.dev) return null;
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_BYTES || bytesRead !== info.size || !AuthSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))).success) return null;
        const after = await file.stat();
        const current = await lstat(path);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
          || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()
          || await realpath(selected) !== canonical) return null;
        return createHmac("sha256", key).update(canonical).update("\0").update(bytes.subarray(0, bytesRead)).digest("hex");
      } finally { bytes.fill(0); await file.close(); }
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[provider-settings] Codex credential proof unavailable:", error instanceof Error ? error.name : "UnknownError");
      }
      return null;
    }
  };
}
