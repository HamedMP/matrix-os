/** Seal and read back the original-byte backup. Never accepts paths from a browser. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, writeFile, rename } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
const [destination, ...roots] = process.argv.slice(2);
if (!destination || !roots.length)
  throw new Error(
    "Manifest destination and captured source directories required",
  );
const base = resolve(destination, "..");
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
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
const files: Array<{ path: string; size: number; sha256: string }> = [];
for (const root of roots)
  for await (const path of walk(resolve(root))) {
    if (files.length >= 1000000)
      throw new Error("Backup manifest needs partitioning");
    const rel = relative(base, path);
    if (rel.startsWith("../") || rel === "..")
      throw new Error("Backup root outside manifest directory");
    const st = await lstat(path);
    files.push({ path: rel, size: st.size, sha256: await hash(path) });
  }
// A second independent read validates restorability against the sealed checksum, not only file existence.
for (const file of files)
  if ((await hash(join(base, file.path))) !== file.sha256)
    throw new Error("Backup changed during verification");
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
console.log(
  JSON.stringify({
    verified: true,
    files: manifest.files,
    bytes: manifest.bytes,
  }),
);
