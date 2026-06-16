import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { validateSessionName } from "./names.js";
import type { ReplayEvent } from "./replay-buffer.js";

export type ScrollbackRecord = Extract<ReplayEvent, { type: "output" | "block-mark" }>;

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
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(
        path,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        { mode: 0o600 },
      );
      await this.enforceLimit(path);
    });
  }

  async readSince(name: string, fromSeq: number): Promise<ScrollbackRecord[]> {
    const safeName = validateSessionName(name);
    try {
      const raw = await readFile(this.pathForValidatedSession(safeName), "utf-8");
      const parsed = parseScrollbackLines(raw.split("\n"), safeName);
      return parsed.records
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
      return parsed.records.at(-1)?.seq ?? null;
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

  async cleanup(name: string): Promise<void> {
    await this.withWriteLock(async () => {
      await rm(this.pathForSession(name), { force: true });
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
