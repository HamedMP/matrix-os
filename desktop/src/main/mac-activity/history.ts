import { WorktreeIdSchema } from "@matrix-os/contracts";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

export const MacActivityScope = z.string().regex(/^[a-f0-9]{64}$/);
export const MacActivityKindSchema = z.enum(["preview", "terminal", "background-checks", "terminal-watch"]);
export const MacActivityPhaseSchema = z.enum([
  "awaiting-approval", "ready", "running", "returning", "returned", "declined", "stopped", "expired", "failed", "revoked",
]);
const Entry = z.strictObject({
  kind: MacActivityKindSchema,
  phase: MacActivityPhaseSchema,
  worktreeId: WorktreeIdSchema,
});
const StoredEntry = Entry.extend({ scope: MacActivityScope, at: z.number().int().nonnegative() });
const MAX_PROFILE_ROWS = 192;
const MAX_OWNER_ROWS = 64;
const MAX_BYTES = 64 * 1024;
const MAX_PENDING = 128;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const Events = z.strictObject({ version: z.literal(1), rows: z.array(StoredEntry).max(MAX_PROFILE_ROWS) });

type StoredEntry = z.infer<typeof StoredEntry>;
export type MacActivityEntry = z.infer<typeof Entry>;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function createMacActivityHistory(userData: string, now = Date.now) {
  const directory = join(userData, "mac-activity");
  const path = join(directory, "events.json");
  const temporary = join(directory, ".events.tmp");
  let queue = Promise.resolve();
  let pending = 0;
  let warned = false;
  function warn() {
    if (!warned) console.warn("[mac-activity] local history unavailable");
    warned = true;
  }

  async function privateDirectory(create: boolean) {
    const parent = await lstat(userData);
    if (!parent.isDirectory()) throw new Error("Unsafe activity profile directory");
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error; }
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Unsafe activity directory");
  }

  async function readStored(): Promise<StoredEntry[]> {
    try {
      await privateDirectory(false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) {
          throw new Error("Unsafe activity file");
        }
        // Reading a fixed buffer prevents a concurrent change from expanding the read.
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_BYTES) throw new Error("Oversized activity file");
        return Events.parse(JSON.parse(buffer.subarray(0, length).toString("utf8"))).rows;
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (missing(error)) return [];
      throw error;
    }
  }

  function retain(rows: StoredEntry[]) {
    const time = now();
    return rows.filter(row => row.at >= time - RETENTION_MS && row.at <= time);
  }

  async function persist(rows: StoredEntry[]) {
    await privateDirectory(true);
    // The single-instance main process owns this fixed, exclusive temporary sibling.
    // unlink does not follow a file symlink and recovers a prior interrupted write.
    try { await unlink(temporary); }
    catch (error: unknown) { if (!missing(error)) throw error; }
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(JSON.stringify({ version: 1, rows }), "utf8"); }
      finally { await file.close(); }
      await rename(temporary, path);
    } finally {
      try { await unlink(temporary); }
      catch (error: unknown) { if (!missing(error)) warn(); }
    }
  }

  function append(scope: string, input: MacActivityEntry): Promise<void> {
    const entry = Entry.safeParse(input);
    if (!MacActivityScope.safeParse(scope).success || !entry.success) return Promise.resolve();
    if (pending >= MAX_PENDING) {
      warn();
      return queue;
    }
    const next = { ...entry.data, scope, at: now() };
    pending++;
    queue = queue.then(async () => {
      const rows = retain(await readStored());
      if (rows.filter(row => row.scope === scope).length >= MAX_OWNER_ROWS) {
        rows.splice(rows.findIndex(row => row.scope === scope), 1);
      }
      await persist([...rows, next].slice(-MAX_PROFILE_ROWS));
      warned = false;
    }).catch(warn).finally(() => { pending--; });
    return queue;
  }

  return {
    append,
    async read(scope: string) {
      if (!MacActivityScope.safeParse(scope).success) return null;
      try {
        await queue;
        return retain(await readStored()).filter(row => row.scope === scope)
          .map(({ kind, phase, worktreeId, at }) => ({ kind, phase, worktreeId, at }));
      } catch (error: unknown) {
        warn();
        return null;
      }
    },
    flush: () => queue,
  };
}
