import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, chmod, lstat, readdir, writeFile, unlink, rm, rmdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineCliEnvelopeSchema, ROUTINE_CLI_OUTPUT_BYTES, type RoutineCliEnvelope } from "@matrix-os/contracts/routine-cli";
import { sanitizeAssistantText } from "./safe-activity-projection.js";
/** Same-UID readable files are display data only. Never consumed as authority or receipt truth.
 * Unique per native execution; recurring symlink-safe TTL sweep, capped files/writes, explicit drain. */
export async function createRoutineResultArtifacts(options: { now?: () => number; ttlMs?: number; maxFiles?: number } = {}) {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 120_000, max = options.maxFiles ?? 32;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120_000 || !Number.isInteger(max) || max < 1 || max > 32) throw new Error("Routine display unavailable");
  const root = join(tmpdir(), `matrix-routine-results-${process.getuid?.() ?? "user"}`);
  try { await mkdir(root, { mode: 0o700 }); } catch (error: unknown) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 || process.getuid && rootStat.uid !== process.getuid()) throw new Error("Routine display unavailable");
  const sweepAbandoned = async () => {
    const names = await readdir(root);
    for (const name of names.slice(0, 256)) {
      if (!/^run-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(root, name); let stat;
      try { stat = await lstat(path); } catch (error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const lease = join(path, ".lease");
      let lastTouched = stat.mtimeMs;
      try { const leased = await lstat(lease); if (leased.isSymbolicLink() || !leased.isFile()) continue; lastTouched = leased.mtimeMs; }
      catch (error: unknown) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      if (Date.now() - lastTouched <= 150_000) continue;
      const children = await readdir(path); if (children.length > 33) continue;
      let safe = true;
      for (const file of children) {
        if (file !== ".lease" && !/^[a-f0-9]{48}\.json$/.test(file)) { safe = false; break; }
        const child = await lstat(join(path, file)); if (!child.isFile() || child.isSymbolicLink()) { safe = false; break; }
      }
      if (!safe) continue;
      for (const file of children) await unlink(join(path, file));
      await rmdir(path);
    }
  };
  await sweepAbandoned();
  if ((await readdir(root)).length >= 64) throw new Error("Routine display unavailable");
  const directory = await mkdtemp(join(root, "run-")); await chmod(directory, 0o700);
  const lease = join(directory, ".lease"); await writeFile(lease, "", { flag: "wx", mode: 0o600 });
  let closed = false, pending = 0, chain: Promise<unknown> = Promise.resolve();
  const files = new Map<string, number>(); // max32, TTL sweep and explicit close.
  const serialize = <T>(work: () => Promise<T>) => {
    if (closed || pending >= 8) return Promise.reject(new Error("Routine display unavailable"));
    pending++; const result = chain.then(work); chain = result.catch(error => { if (!(error instanceof Error)) console.warn("[routine-display] Operation unavailable"); }).finally(() => { pending--; }); return result;
  };
  const sweepFiles = async () => {
    const actualNow = new Date(); await utimes(lease, actualNow, actualNow);
    await sweepAbandoned();
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
      const path = join(directory, name); let stat;
      try { stat = await lstat(path); } catch (error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { files.delete(path); continue; } throw error; }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if ((files.get(path) ?? stat.mtimeMs) + ttl <= now()) { await unlink(path); files.delete(path); }
    }
  };
  const sweep = () => serialize(sweepFiles);
  const timer = setInterval(() => { void sweep().catch(error => console.warn("[routine-display] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")); }, Math.min(ttl, 30_000)); timer.unref();
  return { directory, sweep,
    write(value: unknown) { return serialize(async () => {
      await sweepFiles(); if (closed || files.size >= max) throw new Error("Routine display unavailable");
      const valueText = JSON.stringify(RoutineCliEnvelopeSchema.parse(value));
      const text = sanitizeAssistantText(valueText, { homePath: directory, showPrivatePaths: false });
      if (Buffer.byteLength(text) > ROUTINE_CLI_OUTPUT_BYTES) throw new Error("Routine display unavailable");
      const path = join(directory, `${randomBytes(24).toString("hex")}.json`);
      await writeFile(path, text + "\n", { flag: "wx", mode: 0o600 }); files.set(path, now());
      return { path, command: `/bin/cat -- '${path.replaceAll("'", "'\\''")}'` };
    }); },
    async close() { if (closed) return; closed = true; clearInterval(timer); await chain; files.clear(); await rm(directory, { recursive: true, force: true }); },
  };
}

export function routineDisplayRequestId(result: RoutineCliEnvelope): string | undefined {
  if (!("ok" in result)) return undefined;
  return result.data.kind === "receipt" ? result.data.receipt.requestId : result.data.kind === "unknown" || result.data.kind === "not_observed" ? result.data.requestId : undefined;
}
export class RoutineDisplayUnavailableError extends Error {
  constructor(readonly requestId?: string) { super("Routine result display unavailable"); this.name = "RoutineDisplayUnavailableError"; }
}
