import { lstatSync, unlinkSync } from "node:fs";
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
  return { dev: entry.dev, ino: entry.ino, birthtimeNs: entry.birthtimeNs };
}

function hasOwnedSocket(path: string, bound: ReturnType<typeof socketIdentity>): boolean {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isSocket() || bound.dev !== entry.dev || bound.ino !== entry.ino
    || bound.birthtimeNs !== entry.birthtimeNs) {
    throw new Error("Scope runtime socket was replaced");
  }
  return true;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function closeOwnedListener(server: Server, path: string, trust: NamespacePathTrust | undefined,
  bound: ReturnType<typeof socketIdentity> | undefined): Promise<void> {
  if (!trust) return closeServer(server);
  if (!bound) throw new Error("Scope runtime socket identity unavailable");

  await assertNamespaceSocket(path, trust);
  if (server.listening) {
    // Native close unlinks the bind pathname. Check ownership on the same turn.
    if (!hasOwnedSocket(path, bound)) throw new Error("Scope runtime socket is missing");
    await closeServer(server);
    // libuv can report successful close even if directory permissions prevented unlink.
    await assertNamespaceSocket(path, trust);
  }
  // A retry after native close only has a pathname left to clean up. Validate its
  // identity immediately before unlinking it, including on the first attempt.
  if (hasOwnedSocket(path, bound)) unlinkSync(path);
}
