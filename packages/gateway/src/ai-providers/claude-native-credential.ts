import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";

const CredentialSchema = z.object({ claudeAiOauth: z.object({
  accessToken: z.string().min(1).max(16_384), expiresAt: z.number().finite(),
  scopes: z.array(z.string().max(120)).max(32),
}) });

/** Owner process only: bounded, no-follow credential read shared by usage and inference. */
export function createClaudeNativeCredentialReader(input: {homePath: string; scope: "user:profile" | "user:inference"; now?: () => Date}) {
  const home = resolve(input.homePath);
  const key = randomBytes(32);
  const now = input.now ?? (()=>new Date());
  const credential = async () => {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) return null;
      const canonical = await realpath(home);
      for (const start of [home, canonical]) for (let parent=start;;parent=dirname(parent)) {
        const info = await lstat(parent);
        const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if ((!info.isDirectory() && !info.isSymbolicLink()) || ![0,uid].includes(info.uid)
          || !info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !stickyRoot
          || parent === start && (info.uid !== uid || info.isSymbolicLink())) return null;
        if (dirname(parent) === parent) break;
      }
      const directory = join(canonical,".claude");
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) return null;
      const path = join(directory,".credentials.json");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o077) !== 0) return null;
      const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(65_537);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size < 2 || info.size > 65_536
          || info.ino !== before.ino || info.dev !== before.dev) return null;
        const {bytesRead} = await file.read(bytes,0,bytes.length,0);
        if (bytesRead !== info.size || bytesRead > 65_536) return null;
        const parsed = CredentialSchema.safeParse(JSON.parse(bytes.subarray(0,bytesRead).toString("utf8")));
        if (!parsed.success || parsed.data.claudeAiOauth.expiresAt <= +now()
          || !parsed.data.claudeAiOauth.scopes.includes(input.scope)) return null;
        const after = await file.stat(); const current = await lstat(path); const currentDir = await lstat(directory);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
          || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()
          || currentDir.ino !== dir.ino || currentDir.dev !== dir.dev || currentDir.isSymbolicLink()
          || await realpath(home) !== canonical) return null;
        return {token:parsed.data.claudeAiOauth.accessToken,
          proof:createHmac("sha256",key).update(canonical).update(bytes.subarray(0,bytesRead)).digest("hex")};
      } finally { bytes.fill(0); await file.close(); }
    } catch(error:unknown) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException)?.code !== "ENOENT")
        console.warn("[provider-settings] Claude native credential unavailable:",error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
  return credential;
}
