import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** flock's inherited open-file description remains locked until our handle closes. */
export async function withBackgroundRuntimeLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", "5", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd], timeout: 6_000, killSignal: "SIGKILL",
      });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("Background runtime lock unavailable")));
    });
    return await operation();
  } finally { await handle.close(); }
}
