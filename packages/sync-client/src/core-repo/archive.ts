/**
 * Matrix Core repo tarball rules (spec 2691, layer 6), applied by the platform
 * before it pins a commit and by every installer before it extracts one.
 *
 * Only regular files and directories under GitHub's single top-level folder
 * are accepted: no links, devices, absolute paths, `..`, or second roots, and
 * bounded entry count, per-file size, and unpacked size. Extraction writes
 * only after the whole archive has been inspected, strips the top folder,
 * drops ownership and special mode bits, and never follows a link.
 */
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  CORE_REPO_MAX_ENTRIES,
  CORE_REPO_MAX_FILE_BYTES,
  CORE_REPO_MAX_TARBALL_BYTES,
  CORE_REPO_MAX_UNPACKED_BYTES,
  coreRepoEntryPath,
} from "@matrix-os/contracts";
import { t, x, type ReadEntry } from "tar";

export class CoreRepoArchiveError extends Error {
  constructor() {
    super("CoreRepoArchiveRejected");
    this.name = "CoreRepoArchiveError";
  }
}

const ACCEPTED_TYPES = new Set(["File", "OldFile", "Directory"]);
const METADATA_TYPES = new Set(["GlobalExtendedHeader", "ExtendedHeader", "NextFileHasLongPath", "NextFileHasLongLinkpath"]);
const PARSE_TIMEOUT_MS = 60_000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unpackedLimit(): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(total > CORE_REPO_MAX_UNPACKED_BYTES + 1024 * 1024 ? new CoreRepoArchiveError() : null, chunk);
    },
  });
}

async function parse(bytes: Uint8Array, sink: NodeJS.WritableStream): Promise<void> {
  try {
    await pipeline(Readable.from([Buffer.from(bytes)]), createGunzip(), unpackedLimit(), sink, { signal: AbortSignal.timeout(PARSE_TIMEOUT_MS) });
  } catch (error: unknown) {
    if (!(error instanceof CoreRepoArchiveError)) {
      console.warn("[core-repo] archive unreadable", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CoreRepoArchiveError();
  }
}

/** Repo-relative file paths, or a CoreRepoArchiveError. Writes nothing. */
export async function inspectCoreRepoArchive(bytes: Uint8Array): Promise<string[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > CORE_REPO_MAX_TARBALL_BYTES) throw new CoreRepoArchiveError();
  const root: { value?: string } = {};
  const files: string[] = [];
  const seen = new Set<string>(); // invocation-local, bounded by CORE_REPO_MAX_ENTRIES
  let entries = 0;
  let unpacked = 0;
  let fault = false;
  await parse(bytes, t({ strict: true, onReadEntry(entry: ReadEntry) {
    try {
      if (METADATA_TYPES.has(entry.type)) return;
      if (++entries > CORE_REPO_MAX_ENTRIES || !ACCEPTED_TYPES.has(entry.type)) throw new CoreRepoArchiveError();
      if (entry.size > CORE_REPO_MAX_FILE_BYTES || (unpacked += entry.size) > CORE_REPO_MAX_UNPACKED_BYTES) throw new CoreRepoArchiveError();
      const path = coreRepoEntryPath(entry.path, root);
      if (!path) {
        if (entry.type !== "Directory") throw new CoreRepoArchiveError();
        return;
      }
      if (seen.has(path)) throw new CoreRepoArchiveError();
      seen.add(path);
      if (entry.type !== "Directory") files.push(path);
    } catch (error: unknown) {
      if (!(error instanceof Error)) console.warn("[core-repo] archive entry rejected");
      fault = true;
    } finally {
      entry.resume();
    }
  } }));
  // A file used as a directory by a later entry would let extraction write through it.
  const fileSet = new Set(files);
  for (const path of seen) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      if (fileSet.has(parts.slice(0, depth).join("/"))) fault = true;
    }
  }
  if (fault || !root.value) throw new CoreRepoArchiveError();
  return files;
}

/** Inspect, then extract into an existing empty directory. */
export async function extractCoreRepoArchive(bytes: Uint8Array, destination: string): Promise<string[]> {
  const files = await inspectCoreRepoArchive(bytes);
  await parse(bytes, x({
    cwd: destination, strict: true, strip: 1, preservePaths: false, preserveOwner: false, noMtime: true,
    filter(_path, entry) {
      if (!("type" in entry) || !ACCEPTED_TYPES.has(entry.type)) return false;
      entry.mode = entry.type === "Directory" ? 0o755 : ((entry.mode ?? 0o644) & 0o111 ? 0o755 : 0o644);
      return true;
    },
  }));
  return files;
}
