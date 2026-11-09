/** Paired-computer recovery job. No listener, credentials in configuration, or renderer-selected command. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { USAGE_BACKUP_PATHS } from "../../packages/contracts/src/ai-usage/node";
import { prepareBackupVersions } from "./backup-versions";
const exec = promisify(execFile);
const [configFile] = process.argv.slice(2);
if (!configFile) throw new Error("Usage config required");
const root = dirname(resolve(configFile)),
  config = JSON.parse(await readFile(configFile, "utf8"));
const run = async (command: string, args: string[]) => {
  await exec(command, args, {
    timeout: 20 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
};
const inside = (path: string) => {
  const rel = relative(root, resolve(path));
  if (rel === ".." || rel.startsWith("../"))
    throw new Error("Backup path outside recovery root");
  return path;
};
const revision = join(root, "revisions", `auto-${randomUUID()}`);
for (const home of config.captureHomes ?? []) {
  if (
    !/^\/home\/[A-Za-z0-9_-]+(?:\/home)?$/.test(home.path) ||
    !/^matrix-(login|runtime)$/.test(home.machine)
  )
    throw new Error("Invalid capture home");
  for (const path of USAGE_BACKUP_PATHS) {
    const source = join(home.path, path);
    let st;
    try {
      st = await lstat(source);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      throw new Error("Invalid history source");
    const destination = join(root, home.machine, path);
    await mkdir(st.isDirectory() ? destination : dirname(destination), {
      recursive: true,
      mode: 0o700,
    });
    await run("rsync", [
      "-a",
      "--no-links",
      "--no-specials",
      "--no-devices",
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      "--backup",
      `--backup-dir=${join(revision, home.machine, st.isDirectory() ? path : dirname(path))}`,
      source + (st.isDirectory() ? "/" : ""),
      destination + (st.isDirectory() ? "/" : ""),
    ]);
  }
}
const versions = await prepareBackupVersions(root);
for (const machine of config.machines) {
  for (const agent of ["claude", "codex"]) {
    const path = join(root, "recovered", machine.id, `.${agent}`);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error("Invalid recovered history");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (!machine.roots.some((r: { path: string }) => r.path === path))
      machine.roots.push({ path, agent });
  }
}
for (const machine of config.machines)
  for (const source of machine.roots) inside(source.path);
inside(config.backupManifest);
await writeFile(configFile + ".pending", JSON.stringify(config), {
  mode: 0o600,
});
await rename(configFile + ".pending", configFile);
const captured: string[] = [];
for (const name of ["mac", "matrix-runtime", "matrix-login", "recovered"]) {
  const path = join(root, name);
  try {
    await lstat(path);
    captured.push(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}
await run(process.execPath, [
  "--import",
  "tsx",
  "scripts/ai-usage/verify-backup.ts",
  config.backupManifest,
  ...captured,
]);
await run(process.execPath, [
  "--import",
  "tsx",
  "scripts/ai-usage/history.ts",
  configFile,
  join(root, "usage-report.json"),
]);
await versions.finish();
console.log("Usage backup verified and historical report refreshed");
