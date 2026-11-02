import { createReadStream } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, posix, sep } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { t, x, type ReadEntry } from "tar";
const LIMIT = 6 * 1024 ** 3, COUNT = 50_000;
const unavailable = () => new Error("Preview desktop is unavailable");
function pathName(raw: string) {
  if (!raw || raw.length > 1024 || /[\x00-\x1f\x7f\\:]/.test(raw) || raw.startsWith("/")) throw unavailable();
  const value = raw.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (value === "." || value === "") return "";
  if (value.split("/").some(part => !part || part === "." || part === "..")) throw unavailable();
  return value;
}
function byteLimit() {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length; callback(bytes > LIMIT ? unavailable() : null, chunk);
  } });
}
async function parse(file: string, parser: NodeJS.WritableStream) {
  await pipeline(createReadStream(file), createGunzip(), byteLimit(), parser,
    { signal: AbortSignal.timeout(60_000) });
}
/** The authenticated outer ZIP is already quarantined. Validate the complete
 * inner archive before writes; allow framework links but no writes through links.
 * No install hooks, shell invocation, ownership restoration or privileged modes. */
export async function extractPreviewDesktop(archive: string, executable: string, parent = tmpdir()) {
  const directory = await realpath(await mkdtemp(join(parent, "matrix-preview-desktop-"))), owner = await lstat(directory);
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== owner.ino || current.dev !== owner.dev) throw unavailable();
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    const entries = new Map<string, { type: string; size: number; link?: string }>(); // invocation-local, <=COUNT, discarded after extraction.
    let count = 0, size = 0, fault: Error | undefined;
    await parse(archive, t({ strict: true, onReadEntry(entry: ReadEntry) {
      try {
        if (++count > COUNT || (size += entry.size) > LIMIT) throw unavailable();
        const path = pathName(entry.path);
        if (!path) { if (entry.type !== "Directory") throw unavailable(); return; }
        if (entries.has(path) || !["File", "Directory", "SymbolicLink"].includes(entry.type)) throw unavailable();
        let link: string | undefined;
        if (entry.type === "SymbolicLink") {
          if (!entry.linkpath || entry.linkpath.length > 1024 || /[\x00-\x1f\x7f\\:]/.test(entry.linkpath) || entry.linkpath.startsWith("/")) throw unavailable();
          link = posix.normalize(posix.join(posix.dirname(path), entry.linkpath));
          if (link === ".." || link.startsWith("../") || link.startsWith("/")) throw unavailable();
        }
        entries.set(path, { type: entry.type, size: entry.size, ...(link ? { link } : {}) });
      } catch (error: unknown) { fault = error instanceof Error ? error : unavailable(); }
    } }));
    if (fault) throw fault;
    for (const path of entries.keys()) {
      const parts = path.split("/"); parts.pop();
      while (parts.length) {
        const ancestor = entries.get(parts.join("/"));
        if (ancestor && ancestor.type !== "Directory") throw unavailable();
        parts.pop();
      }
    }
    const binary = pathName(executable), selected = entries.get(binary);
    if (!selected || selected.type !== "File") throw unavailable();
    await parse(archive, x({ cwd: directory, strict: true, preservePaths: false, preserveOwner: false,
      noMtime: true, filter(_path, entry) {
        // This is the parser's ReadEntry, not a filesystem stat.
        entry.mode = (entry.mode ?? 0o644) & 0o777;
        return "type" in entry && entry.type !== "SymbolicLink";
      } }));
    // The maintained extractor intentionally rejects link-to-link targets.
    // macOS frameworks require them: materialize only our prevalidated internal
    // links after all regular writes, then resolve the complete graph.
    for (const [path, entry] of entries) if (entry.link) {
      await symlink(posix.relative(posix.dirname(path), entry.link), join(directory, path));
    }
    for (const [path, entry] of entries) if (entry.type === "SymbolicLink") {
      const target = await realpath(join(directory, path));
      if (target !== directory && !target.startsWith(directory + sep)) throw unavailable();
    }
    const path = join(directory, binary), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
    await access(path, constants.X_OK);
    return { directory, executable: path, dispose };
  } catch (error: unknown) {
    await dispose(); console.warn("[preview-pair] desktop extraction unavailable", error instanceof Error ? error.name : "UnknownError");
    throw unavailable();
  }
}
