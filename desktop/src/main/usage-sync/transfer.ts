import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { runSyncProcess } from "./process";
import { USAGE_BACKUP_PATHS } from "@matrix-os/contracts/ai-usage/node";
const remotePath = z
  .string()
  .min(2)
  .max(512)
  .regex(/^\/home\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+$/)
  .refine((p) => !p.split("/").includes(".."));
export const UsageSyncPairingSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  runtimeSlot: z.string().min(1).max(128),
  gatewayOrigin: z.url(),
  sshHost: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  backupRoot: remotePath,
  checkout: remotePath,
  databaseEnv: remotePath,
});
export type UsageSyncPairing = z.infer<typeof UsageSyncPairingSchema>;
export async function readUsageSyncPairing(path: string) {
  try {
    const st = await lstat(path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.size > 8192 ||
      (st.mode & 0o077) !== 0
    )
      throw new Error("Invalid usage pairing");
    return UsageSyncPairingSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}
// Deliberately excludes credential files, browser profiles and account databases.
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
];
export async function transferUsageHistory(
  pairing: UsageSyncPairing,
  home: string,
  signal: AbortSignal,
  run = runSyncProcess,
) {
  const config = UsageSyncPairingSchema.parse(pairing),
    active: Array<{ relative: string; directory: boolean }> = [];
  for (const relative of USAGE_BACKUP_PATHS) {
    try {
      const st = await lstat(join(home, relative));
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
        throw new Error("Invalid usage source");
      active.push({ relative, directory: st.isDirectory() });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  if (!active.length) throw new Error("No usage sources");
  const revision = `${config.backupRoot}/revisions/auto-${randomUUID()}`;
  // Paths are operator configuration, validated before entering the remote shell. Never renderer inputs.
  const dirs = active.map(
    (s) =>
      `${config.backupRoot}/mac/${s.directory ? s.relative : s.relative.slice(0, s.relative.lastIndexOf("/"))}`,
  );
  await run(
    "ssh",
    [
      ...sshOptions,
      config.sshHost,
      `cd '${config.checkout}' && node --import tsx scripts/ai-usage/check-pairing.ts '${config.backupRoot}/collector.json' '${config.ownerId}' && umask 077 && mkdir -p ${dirs.map((p) => `'${p}'`).join(" ")}`,
    ],
    signal,
  );
  for (const source of active) {
    signal.throwIfAborted();
    await run(
      "rsync",
      [
        "-a",
        "--no-links",
        "--no-devices",
        "--no-specials",
        "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
        "--backup",
        `--backup-dir=${revision}/mac/${source.directory ? source.relative : posix.dirname(source.relative)}`,
        "-e",
        `ssh ${sshOptions.join(" ")}`,
        `${join(home, source.relative)}${source.directory ? "/" : ""}`,
        `${config.sshHost}:${config.backupRoot}/mac/${source.relative}${source.directory ? "/" : ""}`,
      ],
      signal,
    );
  }
  await run(
    "ssh",
    [
      ...sshOptions,
      config.sshHost,
      `cd '${config.checkout}' && set -a && . '${config.databaseEnv}' && set +a && AI_USAGE_TIMEZONE=Europe/Stockholm flock -n '${config.backupRoot}/.refresh.lock' node --import tsx scripts/ai-usage/refresh.ts '${config.backupRoot}/collector.json'`,
    ],
    signal,
  );
}
