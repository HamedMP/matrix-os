import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { TerminalCaller } from "./terminal-agent-client.js";

/** Claims older than a day are long past any lease (at most an hour). */
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIMS_PER_PROFILE_MAX = 200;
const CLAIM_FILE = /^msg_[A-Za-z0-9]{8,40}\.json$/;
const TASK_ID = /^msg_[A-Za-z0-9]{8,40}$/;

const StoredClaimSchema = z.object({
  taskId: z.string().regex(TASK_ID),
  epoch: z.number().int().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  board: z.string().min(1).max(64),
  claimedAt: z.string().max(64),
  leaseSeconds: z.number().int().min(10).max(3_600).optional(),
  renewedAt: z.string().max(64).optional(),
});
export type StoredClaim = z.infer<typeof StoredClaimSchema>;

function isCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

/** The directory name for one caller: a Matrix terminal pane `<session>_<pane>`, else `default`. */
export function claimCallerKey(caller: TerminalCaller | undefined): string {
  return caller ? `${caller.sessionName}_${caller.paneId}` : "default";
}

/**
 * Claims this CLI holds, one owner-only file per task under
 * `~/.matrixos/board/claims/<profile|default>/<pane|default>/`, so settle verbs need
 * only the ID and two panes using the same profile never share a claim file.
 */
export class BoardClaimStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(options: { home: string; profile?: string; caller?: TerminalCaller; now?: () => number }) {
    this.dir = join(options.home, ".matrixos", "board", "claims", options.profile ?? "default", claimCallerKey(options.caller));
    this.now = options.now ?? Date.now;
  }

  private file(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error("invalid task id");
    return join(this.dir, `${taskId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("claims directory is not a directory");
    if ((info.mode & 0o077) !== 0) await chmod(this.dir, 0o700);
  }

  async save(claim: StoredClaim): Promise<void> {
    const record = StoredClaimSchema.parse(claim);
    await this.ensureDir();
    await this.prune();
    const temp = join(this.dir, `.${record.taskId}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await rename(temp, this.file(record.taskId));
    } catch (error: unknown) {
      await unlink(temp).catch((cleanupError: unknown) => {
        if (!isCode(cleanupError, "ENOENT")) console.warn("[matrix] board claim temp file left behind");
      });
      throw error;
    }
  }

  /** The remembered claim, or null when none is stored or the file is not one this CLI wrote. */
  async load(taskId: string): Promise<StoredClaim | null> {
    const path = this.file(taskId);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return null;
      const parsed = StoredClaimSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success && parsed.data.taskId === taskId ? parsed.data : null;
    } catch (error: unknown) {
      if (isCode(error, "ENOENT", "ENOTDIR") || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /** Removes the remembered claim, but only while it is still the claim of `epoch`. */
  async forget(taskId: string, epoch: number): Promise<void> {
    const path = this.file(taskId);
    try {
      const current = await this.load(taskId);
      if (!current || current.epoch !== epoch) return;
      await unlink(path);
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT", "ENOTDIR")) throw error;
    }
  }

  /** Drops claims older than a day and keeps at most 200; never follows symlinks. */
  private async prune(): Promise<void> {
    const names = (await readdir(this.dir)).filter((name) => CLAIM_FILE.test(name) || name.endsWith(".tmp"));
    const entries: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (this.now() - info.mtimeMs > CLAIM_MAX_AGE_MS) await unlink(path);
        else if (!name.endsWith(".tmp")) entries.push({ path, mtimeMs: info.mtimeMs });
      } catch (error: unknown) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of entries.slice(0, Math.max(0, entries.length - (CLAIMS_PER_PROFILE_MAX - 1)))) {
      await unlink(entry.path).catch((error: unknown) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
    }
  }
}
