import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateSessionName } from "./names.js";
import type { ReplayEvent } from "./replay-buffer.js";

export type ScrollbackRecord = Extract<ReplayEvent, { type: "output" | "block-mark" }>;

export interface ScrollbackStoreOptions {
  homePath: string;
  maxBytesPerSession?: number;
  scrollbackDir?: string;
}

export class ScrollbackStore {
  private readonly scrollbackDir: string;
  private readonly maxBytesPerSession: number;

  constructor(options: ScrollbackStoreOptions) {
    this.scrollbackDir = options.scrollbackDir ?? join(options.homePath, "system", "scrollback");
    this.maxBytesPerSession = options.maxBytesPerSession ?? 5 * 1024 * 1024;
  }

  pathForSession(name: string): string {
    return join(this.scrollbackDir, `${validateSessionName(name)}.ndjson`);
  }

  async append(name: string, records: ScrollbackRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const path = this.pathForSession(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(
      path,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 },
    );
    await this.enforceLimit(path);
  }

  async readSince(name: string, fromSeq: number): Promise<ScrollbackRecord[]> {
    try {
      const raw = await readFile(this.pathForSession(name), "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ScrollbackRecord)
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
    const records = await this.readSince(name, 0);
    return records.length === 0 ? null : records[records.length - 1]!.seq;
  }

  async cleanup(name: string): Promise<void> {
    await rm(this.pathForSession(name), { force: true });
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
}
