import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ResourceCatalogError } from "./resource-catalog.js";

type ReadIdentity = (fd: number) => unknown;
let native: { readIdentity: ReadIdentity } | undefined;
function readNative(fd: number): unknown {
  // Source and compiled loaders both use the generated, shipped dist payload.
  // A missing/incompatible addon is unavailable, never a weaker stat identity.
  native ??= createRequire(import.meta.url)(fileURLToPath(new URL("../../dist/collaboration/filesystem-identity.node", import.meta.url))) as { readIdentity: ReadIdentity };
  return native.readIdentity(fd);
}

/**
 * Local Linux ext4/tmpfs object handles are generation-aware and survive gateway
 * restarts on the same filesystem. ext4 requires proven metadata_csum and an
 * unfiltered owning process; inode ownership alone cannot authorize generation
 * changes. Filesystem administrators/clones remain outside this boundary.
 */
export function createFilesystemIncarnation(readIdentity: ReadIdentity = readNative): (fd: number) => string {
  return (fd) => {
    try {
      if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) throw new Error("Invalid descriptor");
      const bytes = readIdentity(fd);
      if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 160
        || bytes.toString("ascii", 0, 4) !== "MFI2"
        || ![0xef53, 0x01021994].includes(bytes.readUInt32BE(4))
        || bytes.subarray(8, 24).every((byte) => byte === 0)
        || bytes.readUInt32BE(24) === 0
        || bytes.readUInt32BE(28) !== bytes.length - 32) throw new Error("Invalid filesystem identity");
      return createHash("sha256").update("matrix-owner-filesystem-generation-v2\0").update(bytes).digest("hex");
    } catch (error: unknown) {
      console.warn("[collaboration-resources] identity unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new ResourceCatalogError("unavailable");
    }
  };
}

export const filesystemIncarnation = createFilesystemIncarnation();
