import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { validateSessionName } from "./names.js";
import type { ReplayEvent } from "./replay-buffer.js";

export type ReplayableScrollbackRecord = Extract<ReplayEvent, { type: "output" | "block-mark" }>;
// seq-reserve records make sequence numbering crash-durable: they raise
// latestSeq so a restarted gateway resumes numbering above anything a client
// may have seen, but they are never replayed as output.
export type ScrollbackRecord = ReplayableScrollbackRecord | { type: "seq-reserve"; seq: number };
type StoredScrollbackRecord = ScrollbackRecord & { at?: string };

export interface ScrollbackActivity {
  latestSeq: number | null;
  latestOutputAt: string | null;
  commandRunning: boolean | null;
  latestCommandMark: Extract<ScrollbackRecord, { type: "block-mark" }>["mark"] | null;
}

const Osc133MarkSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("A"), kind: z.literal("prompt-start") }),
  z.object({ code: z.literal("B"), kind: z.literal("command-start") }),
  z.object({ code: z.literal("C"), kind: z.literal("command-executed") }),
  z.object({
    code: z.literal("D"),
    kind: z.literal("command-finished"),
    exitCode: z.number().int().nullable(),
  }),
]);

const ScrollbackRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("output"),
    seq: z.number().int().nonnegative(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("block-mark"),
    seq: z.number().int().nonnegative(),
    mark: Osc133MarkSchema,
  }),
  z.object({
    type: z.literal("seq-reserve"),
    seq: z.number().int().nonnegative(),
  }),
]);

export interface ScrollbackStoreOptions {
  homePath: string;
  maxBytesPerSession?: number;
  scrollbackDir?: string;
}

export class ScrollbackStore {
  private readonly scrollbackDir: string;
  private readonly maxBytesPerSession: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ScrollbackStoreOptions) {
    this.scrollbackDir = options.scrollbackDir ?? join(options.homePath, "system", "scrollback");
    this.maxBytesPerSession = options.maxBytesPerSession ?? 5 * 1024 * 1024;
  }

  pathForSession(name: string): string {
    return this.pathForValidatedSession(validateSessionName(name));
  }

  async append(name: string, records: ScrollbackRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.withWriteLock(async () => {
      const path = this.pathForSession(name);
      const at = new Date().toISOString();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(
        path,
        records.map((record) => JSON.stringify({ ...record, at })).join("\n") + "\n",
        { mode: 0o600 },
      );
      await this.enforceLimit(path);
    });
  }

  async readSince(name: string, fromSeq: number): Promise<ReplayableScrollbackRecord[]> {
    const safeName = validateSessionName(name);
    try {
      const raw = await readFile(this.pathForValidatedSession(safeName), "utf-8");
      const parsed = parseScrollbackLines(raw.split("\n"), safeName);
      return parsed.records
        .filter((record): record is ReplayableScrollbackRecord => record.type !== "seq-reserve")
        .filter((record) => record.seq >= fromSeq)
        .sort((a, b) => a.seq - b.seq);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
  }

  async latestSeq(name: string): Promise<number | null> {
    const safeName = validateSessionName(name);
    try {
      const raw = await readFile(this.pathForValidatedSession(safeName), "utf-8");
      const parsed = parseScrollbackLines(raw.split("\n"), safeName);
      // Max across all records, not last-by-file-position: seq-reserve records
      // are appended immediately while output records flush later via the
      // coalescing queue, so file order does not track seq order. Seeding from
      // anything but the max would let a restarted gateway reuse delivered
      // seqs — the exact failure the reservation exists to prevent.
      let latest: number | null = null;
      for (const record of parsed.records) {
        if (latest === null || record.seq > latest) {
          latest = record.seq;
        }
      }
      return latest;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  }

  async latestActivity(name: string): Promise<ScrollbackActivity> {
    try {
      const handle = await open(this.pathForSession(name), "r");
      try {
        const info = await handle.stat();
        let position = info.size;
        let text = "";
        let bytesRead = 0;
        const maxScanBytes = Math.min(info.size, 256 * 1024);
        while (position > 0 && bytesRead < maxScanBytes) {
          const length = Math.min(64 * 1024, position, maxScanBytes - bytesRead);
          position -= length;
          bytesRead += length;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, position);
          text = `${buffer.toString("utf-8")}${text}`;
        }

        const activity: ScrollbackActivity = {
          latestSeq: null,
          latestOutputAt: null,
          commandRunning: null,
          latestCommandMark: null,
        };
        const fallbackAt = info.mtime.toISOString();
        const lines = text.split("\n").filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          let record: StoredScrollbackRecord;
          try {
            record = JSON.parse(lines[index]!) as StoredScrollbackRecord;
          } catch (err: unknown) {
            if (!(err instanceof SyntaxError)) {
              throw err;
            }
            continue;
          }
          if (activity.latestSeq === null && record.type !== "seq-reserve") {
            activity.latestSeq = record.seq;
          }
          if (record.type === "output" && activity.latestOutputAt === null) {
            activity.latestOutputAt = record.at ?? fallbackAt;
          }
          if (record.type === "block-mark" && activity.latestCommandMark === null) {
            activity.latestCommandMark = record.mark;
            activity.commandRunning = record.mark.kind === "command-start" || record.mark.kind === "command-executed";
          }
          if (
            activity.latestSeq !== null &&
            activity.latestOutputAt !== null &&
            activity.latestCommandMark !== null
          ) {
            break;
          }
        }
        return activity;
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return {
          latestSeq: null,
          latestOutputAt: null,
          commandRunning: null,
          latestCommandMark: null,
        };
      }
      throw err;
    }
  }

  async cleanup(name: string): Promise<void> {
    await this.withWriteLock(async () => {
      await rm(this.pathForSession(name), { force: true });
    });
  }

  async rename(fromName: string, toName: string): Promise<void> {
    await this.withWriteLock(async () => {
      const fromPath = this.pathForSession(fromName);
      const toPath = this.pathForSession(toName);
      await mkdir(dirname(toPath), { recursive: true, mode: 0o700 });
      try {
        await rename(fromPath, toPath);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return;
        }
        throw err;
      }
    });
  }

  private async enforceLimit(path: string): Promise<void> {
    const info = await stat(path);
    if (info.size <= this.maxBytesPerSession) {
      return;
    }

    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      const nextBytes = Buffer.byteLength(line) + 1;
      if (bytes + nextBytes > this.maxBytesPerSession && kept.length > 0) {
        break;
      }
      kept.unshift(line);
      bytes += nextBytes;
    }

    const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp-${process.pid}`);
    try {
      await writeFile(tmp, kept.join("\n") + "\n", { flag: "wx", mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async withWriteLock(fn: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private pathForValidatedSession(name: string): string {
    return join(this.scrollbackDir, `${name}.ndjson`);
  }
}

function parseScrollbackLines(lines: string[], session: string): { records: ScrollbackRecord[]; malformed: number } {
  const records: ScrollbackRecord[] = [];
  let malformed = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = ScrollbackRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        malformed += 1;
      }
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[shell] unexpected scrollback parse failure:", {
          session,
          error: err instanceof Error ? err.name : typeof err,
        });
      }
      malformed += 1;
    }
  }
  if (malformed > 0) {
    console.warn("[shell] skipped malformed scrollback records:", {
      session,
      count: malformed,
    });
  }
  return { records, malformed };
}
