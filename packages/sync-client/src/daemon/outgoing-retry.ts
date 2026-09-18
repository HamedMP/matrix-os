import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hashFile } from "../lib/hash.js";
import type { WatcherEvent } from "./watcher.js";

/** Retain outgoing intent separately from remote reconciliation; replay current bytes. */
export function createOutgoingRetry(options: {
  syncRoot: string;
  replay: (event: WatcherEvent) => Promise<void>;
  onError: (error: unknown, path: string) => void;
  onOverflow: () => void;
}) {
  const pending = new Set<string>();
  return {
    has: (path: string) => pending.has(path),
    succeeded: (path: string) => { pending.delete(path); },
    failed(path: string) {
      pending.delete(path);
      if (pending.size >= 1000) {
        const oldest = pending.values().next().value;
        if (oldest !== undefined) pending.delete(oldest);
        options.onOverflow();
      }
      pending.add(path);
    },
    async retry(shouldReplay: (path: string) => boolean = () => true) {
      for (const path of [...pending]) {
        if (!shouldReplay(path)) continue;
        try {
          const absolute = resolve(options.syncRoot, path);
          const rel = relative(resolve(options.syncRoot), absolute);
          if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid retry path");
          let event: WatcherEvent;
          try {
            const info = await lstat(absolute);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error("Retry target is not a regular file");
            const [root, target] = await Promise.all([realpath(options.syncRoot), realpath(absolute)]);
            const canonical = relative(root, target);
            if (canonical === ".." || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) throw new Error("Retry target escaped root");
            event = { type: "change", path, hash: await hashFile(target), size: info.size, mtime: info.mtimeMs };
          } catch (error: unknown) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            event = { type: "unlink", path };
          }
          await options.replay(event);
        } catch (error: unknown) { options.onError(error, path); }
      }
    },
  };
}
