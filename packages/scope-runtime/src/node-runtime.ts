import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assertNamespaceDirectory, HOST_NAMESPACE_TRUST, type NamespacePathTrust } from "./namespace-ancestry.js";
import { createScopeRuntimeUnitIdentity } from "./systemd-unit-identity.js";

export const WORKER_NODE_ROOT = "/opt/matrix/runtime/node";
export const WORKER_NODE_BINARY = WORKER_NODE_ROOT + "/bin/node";
const DEFAULT_NODE_MOUNT = `BindReadOnlyPaths=${WORKER_NODE_ROOT}`;

export function ownedNodeForNamespace(namespace: string | undefined) {
  if (!namespace) throw new Error("Owned Node requires a namespace");
  createScopeRuntimeUnitIdentity(namespace);
  const root = `/var/lib/matrix-devstack/${namespace}/runtime/node`;
  return { root, binary: root + "/bin/node", workerRoot: WORKER_NODE_ROOT, workerBinary: WORKER_NODE_BINARY } as const;
}

export type OwnedNode = ReturnType<typeof ownedNodeForNamespace>;

export function selectOwnedNode(namespace: string | undefined, override: string | undefined) {
  if (override === undefined) return undefined;
  const selected = ownedNodeForNamespace(namespace);
  if (override !== selected.root) throw new Error("Owned Node requires its canonical namespace runtime root");
  return selected;
}

export async function assertProtectedNodeRoot(root: string, trust: NamespacePathTrust = HOST_NAMESPACE_TRUST) {
  const bin = join(root, "bin");
  await assertNamespaceDirectory(bin, trust);
  // Placement permits missing descendants for new runtime state. The mounted
  // runtime must already exist and the sandbox's dynamic UID must traverse it.
  for (const path of [root, bin]) {
    const directory = await lstat(path);
    if (!directory.isDirectory() || (directory.mode & 0o001) === 0) throw new Error("Unsafe Node directory");
  }
  const file = await lstat(join(bin, "node"));
  if (!file.isFile() || file.uid !== trust.uid || file.nlink !== 1 || (file.mode & 0o6022) !== 0
    || (file.mode & 0o005) !== 0o005) throw new Error("Unsafe Node executable");
}

export function nodeMount(property: string, owned?: OwnedNode): string {
  return owned && property === DEFAULT_NODE_MOUNT
    ? `BindReadOnlyPaths=${owned.root}:${WORKER_NODE_ROOT}` : property;
}

/** Namespace-specific attestation binds the base profile and the one permitted mount substitution. */
export function nodeProfileDigest(baseDigest: string, owned?: OwnedNode): string {
  if (!owned) return baseDigest;
  return createHash("sha256").update(`${baseDigest}\n${nodeMount(DEFAULT_NODE_MOUNT, owned)}\n`).digest("hex");
}
