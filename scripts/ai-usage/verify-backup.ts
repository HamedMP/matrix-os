/** Seal and read back the original-byte backup. Never accepts paths from a browser. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpathSync } from "node:fs";
import { lstat, opendir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, relative } from "node:path";
type Entry = { path: string; size: number; sha256: string };
/** Returns the whole-file digest and, when asked, the digest of its first `prefix` bytes. */
async function hash(path: string, prefix?: number) {
  const whole = createHash("sha256");
  let head: string | undefined,
    read = 0;
  if (prefix === 0) head = createHash("sha256").digest("hex");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    if (prefix && head === undefined && read + chunk.length >= prefix) {
      const partial = whole.copy();
      partial.update(chunk.subarray(0, prefix - read));
      head = partial.digest("hex");
    }
    whole.update(chunk);
    read += chunk.length;
  }
  return { sha256: whole.digest("hex"), head };
}
async function* walk(path: string, depth = 0): AsyncGenerator<string> {
  if (depth > 32) throw new Error("Backup nesting limit");
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error("Backup contains symlink");
  if (st.isFile()) {
    yield path;
    return;
  }
  const dir = await opendir(path);
  for await (const entry of dir) yield* walk(join(path, entry.name), depth + 1);
}
async function previousEntries(destination: string): Promise<Entry[]> {
  try {
    const manifest = JSON.parse(await readFile(destination, "utf8"));
    return Array.isArray(manifest.entries) ? manifest.entries : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}
/** A new seal is only written when every original from the previous seal still exists:
 * either byte-identical somewhere in the backup (unchanged, or preserved after replacement),
 * or as the leading bytes of the same file (an appended transcript). Anything else is corruption or loss. */
export async function sealBackup(destination: string, roots: string[]) {
  const base = resolve(destination, "..");
  const previous = await previousEntries(destination);
  const sealed = new Map(previous.map((entry) => [entry.path, entry])); // One manifest, capped below.
  const files: Entry[] = [],
    heads = new Map<string, string | undefined>(); // Same cap; released on return.
  for (const root of roots)
    for await (const path of walk(resolve(root))) {
      if (files.length >= 1000000)
        throw new Error("Backup manifest needs partitioning");
      const rel = relative(base, path);
      if (rel.startsWith("../") || rel === "..")
        throw new Error("Backup root outside manifest directory");
      const st = await lstat(path),
        before = sealed.get(rel);
      const result = await hash(
        path,
        before && before.size <= st.size ? before.size : undefined,
      );
      heads.set(rel, result.head);
      files.push({ path: rel, size: st.size, sha256: result.sha256 });
    }
  // A second independent read validates restorability against the sealed checksum, not only file existence.
  for (const file of files)
    if ((await hash(join(base, file.path))).sha256 !== file.sha256)
      throw new Error("Backup changed during verification");
  const present = new Set(files.map((file) => file.sha256));
  const lost = previous.filter(
    (entry) =>
      !present.has(entry.sha256) && heads.get(entry.path) !== entry.sha256,
  );
  if (lost.length) {
    for (const entry of lost.slice(0, 20))
      console.error(`Changed or missing since last seal: ${entry.path}`);
    throw new Error(
      `${lost.length} verified original${lost.length === 1 ? "" : "s"} changed or missing; previous seal kept`,
    );
  }
  const manifest = {
    version: 1,
    verified: true,
    verifiedAt: new Date().toISOString(),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    entries: files,
  };
  await writeFile(destination + ".pending", JSON.stringify(manifest), {
    mode: 0o600,
  });
  await rename(destination + ".pending", destination);
  return manifest;
}
// Node resolves the main module to its real path while argv keeps a symlinked one; compare real paths
// so a symlinked checkout can never turn this command into a silent no-op.
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const [destination, ...roots] = process.argv.slice(2);
  if (!destination || !roots.length)
    throw new Error(
      "Manifest destination and captured source directories required",
    );
  const manifest = await sealBackup(destination, roots);
  console.log(
    JSON.stringify({
      verified: true,
      files: manifest.files,
      bytes: manifest.bytes,
    }),
  );
}
