import { chmod, lstat, mkdir, mkdtemp, readdir, rm, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// <=128 in-process initializations; removed after lease setup or failed-setup cleanup.
const initializing = new Set<string>();
/** Finite owned files only; recurring symlink-safe crash sweep, live lease, exclusive creation, explicit close. */
export async function createPiExtensionFiles() {
  const root = join(tmpdir(), `matrix-pi-extensions-${process.getuid?.() ?? "user"}`);
  try { await mkdir(root, { mode: 0o700 }); } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 || process.getuid && rootStat.uid !== process.getuid()) throw new Error("Pi extension unavailable");
  const sweep = async () => {
    for (const name of (await readdir(root)).slice(0, 256)) {
      if (!/^run-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(root, name);
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || initializing.has(path)) continue;
        // A crashed setup may never create its lease. Fresh directories retain the same
        // grace across processes; the held set also protects a slow local initialization.
        let lastTouched = stat.mtimeMs;
        try {
          const lease = await lstat(join(path, ".lease"));
          if (!lease.isFile() || lease.isSymbolicLink()) continue;
          lastTouched = lease.mtimeMs;
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        if (Date.now() - lastTouched < 31 * 60_000) continue;
        const files = await readdir(path);
        if (files.length > 3 || files.some(file => ![".lease", "ask-user.ts", "routines.mjs"].includes(file))) continue;
        const stats = await Promise.all(files.map(file => lstat(join(path, file))));
        if (stats.some(file => !file.isFile() || file.isSymbolicLink())) continue;
        for (const file of files) await unlink(join(path, file));
        await rmdir(path);
      } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    }
  };
  await sweep();
  if ((await readdir(root)).length >= 128) throw new Error("Pi extension capacity unavailable");
  const directory = await mkdtemp(join(root, "run-")), lease = join(directory, ".lease");
  try {
    if (initializing.size >= 128) throw new Error("Pi extension capacity unavailable");
    initializing.add(directory);
    await chmod(directory, 0o700);
    await writeFile(lease, "", { mode: 0o600, flag: "wx" });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { initializing.delete(directory); }
  let closed = false, cleaning: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (closed || cleaning) return;
    cleaning = (async () => { const now = new Date(); await utimes(lease, now, now); await sweep(); })()
      .catch(error => console.warn("[pi-extension] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError"))
      .finally(() => { cleaning = undefined; });
  }, 30_000); timer.unref();
  return { directory, async dispose() { closed = true; clearInterval(timer); await cleaning; await rm(directory, { recursive: true, force: true }); } };
}
