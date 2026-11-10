import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { verifyOpenMausPreviewModelKey } from "./model.js";

const MAX_KEY_BYTES = 512;
const HOSTED_BOTS_STATE = "/var/lib/matrix-hosted-bots";

export function hostedBotsCredentialPath(stateDirectories: string | undefined, ownerHome: string): string | null {
  if (!isAbsolute(ownerHome) || !stateDirectories?.split(":").includes(HOSTED_BOTS_STATE)) return null;
  const fromHome = relative(ownerHome, HOSTED_BOTS_STATE);
  if (fromHome !== ".." && !fromHome.startsWith(".." + sep)) return null;
  return join(HOSTED_BOTS_STATE, "provider-key");
}

export async function isHostedBotsCredentialDirectoryUsable(path: string, ownerHome: string) {
  const directory = dirname(path);
  const state = await lstat(directory);
  if (!state.isDirectory() || state.uid !== process.geteuid?.() || (state.mode & 0o077)) return false;
  if (await realpath(directory) !== directory) return false;
  return hostedBotsCredentialPath(directory, await realpath(ownerHome)) === path;
}


function notFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Separate per-owner-computer credential. The fixed path is outside Matrix app/workspace storage. */
export function createHostedBotsCredentials(path: string) {
  async function readKey(): Promise<string | null> {
    const directory = dirname(path);
    try {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o077)) throw new Error("Unsafe Bot credential directory");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const state = await file.stat();
        if (!state.isFile() || state.uid !== process.geteuid?.() || state.nlink !== 1 || (state.mode & 0o077) || state.size < 1 || state.size > MAX_KEY_BYTES) {
          throw new Error("Unsafe Bot credential file");
        }
        const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== state.size) throw new Error("Bot credential file changed");
        return buffer.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  return {
    readKey,
    connected: async () => Boolean(await readKey()),
    async connect(apiKey: string) {
      await verifyOpenMausPreviewModelKey(apiKey);
      const directory = dirname(path);
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o077)) throw new Error("Unsafe Bot credential directory");
      const pending = join(directory, "." + randomUUID() + ".tmp");
      try {
        await writeFile(pending, apiKey, { mode: 0o600, flag: "wx" });
        await rename(pending, path);
      } finally {
        await rm(pending, { force: true });
      }
    },
  };
}
