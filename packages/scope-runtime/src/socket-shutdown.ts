import { lstatSync } from "node:fs";
import type { Server } from "node:net";
import { assertNamespaceSocket, type NamespacePathTrust } from "./namespace-ancestry.js";

/** Concurrent callers share the attempt; only success is permanent. */
export function retryableClose(close: () => Promise<void>) {
  let attempt: Promise<void> | undefined;
  return () => attempt ??= close().catch((error: unknown) => { attempt = undefined; throw error; });
}

/** A failure in one owner must neither skip nor race a retry against another owner's cleanup. */
export async function finishCloses(...closes: Promise<void>[]): Promise<void> {
  for (const result of await Promise.allSettled(closes)) {
    if (result.status === "rejected") throw result.reason;
  }
}

export function socketIdentity(path: string) {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isSocket()) throw new Error("Unsafe scope runtime socket");
  return { dev: entry.dev, ino: entry.ino };
}

export async function closeOwnedListener(server: Server, path: string, trust: NamespacePathTrust | undefined,
  bound: ReturnType<typeof socketIdentity> | undefined): Promise<void> {
  if (trust) {
    await assertNamespaceSocket(path, trust);
    // Node/libuv unlinks its bind pathname on close. Do the final identity check and
    // initiate close on the same turn; never unlink that path again after close.
    const current = socketIdentity(path);
    if (!bound || bound.dev !== current.dev || bound.ino !== current.ino) {
      throw new Error("Scope runtime socket was replaced");
    }
  }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
