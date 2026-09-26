import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FSWatcher } from "chokidar";

const HASH_STREAM_TIMEOUT_MS = 30_000;

export function hashFileStream(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    const timeout = setTimeout(() => {
      s.destroy(new Error(`hash stream timed out after ${HASH_STREAM_TIMEOUT_MS}ms`));
    }, HASH_STREAM_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => {
      cleanup();
      resolve(`sha256:${h.digest("hex")}`);
    });
    s.on("error", (err) => {
      cleanup();
      reject(err);
    });
    s.on("close", cleanup);
  });
}

export function hashBuffer(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

export type LocalPushFile =
  | { kind: "file"; body: Buffer; hash: string; size: number }
  | { kind: "too_large"; size: number }
  | { kind: "skip" };

export async function readLocalFileForPush(
  absPath: string,
  maxPushBytes: number,
): Promise<LocalPushFile> {
  let handle;
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      ["ENOENT", "EISDIR", "ELOOP", "ENOTDIR"].includes(
        String((err as NodeJS.ErrnoException).code),
      )
    ) {
      return { kind: "skip" };
    }
    throw err;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      return { kind: "skip" };
    }
    if (fileStat.size > maxPushBytes) {
      return { kind: "too_large", size: fileStat.size };
    }
    const body = Buffer.from(await handle.readFile());
    return {
      kind: "file",
      body,
      hash: hashBuffer(body),
      size: body.length,
    };
  } finally {
    await handle.close();
  }
}

export function createSerialQueue(onError: (err: unknown) => void): {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  drain: () => Promise<void>;
} {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    return next;
  };
  return {
    enqueue,
    async drain(): Promise<void> {
      await chain;
    },
  };
}

export function waitForWatcherReady(target: FSWatcher): Promise<void> {
  // Resolve on `close` too, so a concurrent stop() can't strand us waiting
  // for a `ready` event that will never fire on a closed watcher.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.off("ready", onReady);
      target.off("error", onError);
      target.off("close", onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    target.once("ready", onReady);
    target.once("error", onError);
    target.once("close", onClose);
  });
}
