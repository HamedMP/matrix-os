import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Compile the manifest identity into main-process code, outside the kit. */
export function readMacVerificationSupportPin(root) {
  let fd;
  try {
    fd = openSync(join(root, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024) throw new Error("Invalid Mac Verification support manifest");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("Mac Verification support manifest changed");
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null; // Local development has no packaged kit.
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
