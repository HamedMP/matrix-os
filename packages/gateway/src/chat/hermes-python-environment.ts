import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Match v0.22 PM's canonical install key and committed generation layout.
 * Never execute owner Python merely to discover its interpreter. A broken
 * committed selection cannot silently revive an old dependency environment.
 */
export async function resolveHermesPython(source: string): Promise<string> {
  const legacy = join(source, "venv/bin/python");
  let canonical: string;
  try { canonical = await realpath(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacy; throw error; }
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const state = join(dirname(canonical), "installs", key);
  const facts = join(state, "facts.json");
  let before: Awaited<ReturnType<typeof lstat>>;
  try { before = await lstat(facts); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacy;
    throw new Error("Hermes runtime setup required", { cause: error });
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // PM's owning state must remain at the canonical install location. Resolving
    // both sides alone would accept a symlink that moves the entire state root.
    if (!before.isFile() || before.size > 1024 * 1024 || await realpath(state) !== state) throw new Error("Invalid runtime state");
    file = await open(facts, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size !== before.size || info.ino !== before.ino || info.dev !== before.dev || info.mtimeMs !== before.mtimeMs) throw new Error("Invalid runtime state");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error("Invalid runtime state");
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const value: unknown = record?.packages?.venv?.environment;
    if (typeof value !== "string" || value.length > 4096 || !isAbsolute(value) || value.includes("\0")) throw new Error("Invalid runtime state");
    const base = join(state, "environments");
    if (await realpath(base) !== base) throw new Error("Invalid runtime state");
    const environment = await realpath(resolve(value));
    const local = relative(base, environment);
    if (!local || local === ".." || local.startsWith("../") || isAbsolute(local)) throw new Error("Invalid runtime state");
    await access(join(environment, "pyvenv.cfg"), constants.R_OK);
    const python = join(environment, "bin/python");
    await access(python, constants.X_OK);
    const after = await file.stat(); const current = await lstat(facts);
    if (!current.isFile() || [after, current].some(stat => stat.ino !== info.ino || stat.dev !== info.dev || stat.size !== info.size || stat.mtimeMs !== info.mtimeMs)
      || await realpath(state) !== state || await realpath(base) !== base) throw new Error("Runtime selection changed");
    return python;
  } catch (error) {
    throw new Error("Hermes runtime setup required", { cause: error });
  } finally { await file?.close(); }
}
