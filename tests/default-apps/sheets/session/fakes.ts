import { isDeepStrictEqual } from "node:util";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import type { SessionDb, SessionDeps, SessionFiles, SessionTimers } from "../../../../home/apps/sheets/src/session";

export function bridgeError(code: string): Error {
  const error = new Error("file error") as Error & { code: string };
  error.name = "BridgeFileError";
  error.code = code;
  return error;
}

interface StoredFile {
  bytes: Uint8Array;
  version: string;
}

/** An in-memory `MatrixOS.files` with versions, conflicts and controllable delays. */
export class FakeFiles implements SessionFiles {
  readonly store = new Map<string, StoredFile>();
  readonly writes: Array<{ path: string; ifVersion: string | null; size: number }> = [];
  /** When set, the next write waits for this gate before it touches the store. */
  gate: Promise<void> | null = null;
  /** When set, the next write fails with this bridge code. */
  failNext: string | null = null;
  private counter = 0;

  put(path: string, bytes: Uint8Array): string {
    const version = `v${++this.counter}`;
    this.store.set(path, { bytes, version });
    return version;
  }

  bytes(path: string): Uint8Array {
    const file = this.store.get(path);
    if (file === undefined) throw new Error(`no file at ${path}`);
    return file.bytes;
  }

  text(path: string): string {
    return new TextDecoder().decode(this.bytes(path));
  }

  async read(path: string) {
    const file = this.store.get(path);
    if (file === undefined) throw bridgeError("not_found");
    return { path, bytes: file.bytes, size: file.bytes.length, version: file.version, mimeType: "application/octet-stream" };
  }

  async write(path: string, bytes: Uint8Array, options: { ifVersion: string | null; createParents?: boolean }) {
    const gate = this.gate;
    this.gate = null;
    if (gate !== null) await gate;
    this.writes.push({ path, ifVersion: options.ifVersion, size: bytes.length });
    if (this.failNext !== null) {
      const code = this.failNext;
      this.failNext = null;
      throw bridgeError(code);
    }
    const existing = this.store.get(path);
    if (options.ifVersion === null ? existing !== undefined : existing?.version !== options.ifVersion) {
      throw bridgeError("version_conflict");
    }
    const version = this.put(path, bytes);
    return { path, version, size: bytes.length, modifiedAt: new Date(0).toISOString() };
  }
}

/** Timers that fire only when the test says so. */
export class FakeTimers implements SessionTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  set(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Runs every pending timer once. Returns how many ran. */
  fire(): number {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, timer] of due) timer.callback();
    return due.length;
  }
}

/**
 * An in-memory `MatrixOS.db` for the recent-files table. Like the gateway, a
 * `bulkInsert` row that collides with the unique `slot` index is skipped, and
 * `compareAndSwap` writes only while the stored `payload` equals the one given.
 */
export class FakeDb implements SessionDb {
  rows: Array<Record<string, unknown> & { id: string }> = [];
  /** Every write call, in order, as `method table`. Each one is a single statement in the gateway. */
  readonly writes: string[] = [];
  private counter = 0;
  fail = false;

  async find(table: string, options?: { where?: Record<string, unknown>; limit?: number }) {
    if (this.fail) throw new Error("db down");
    void table;
    const matching = this.rows.filter((row) => Object.entries(options?.where ?? {}).every(([column, expected]) => row[column] === expected));
    return matching.slice(0, options?.limit ?? matching.length).map((row) => structuredClone(row));
  }

  async bulkInsert(table: string, rows: Array<Record<string, unknown>>) {
    if (this.fail) throw new Error("db down");
    this.writes.push(`bulkInsert ${table}`);
    const ids: string[] = [];
    for (const data of rows) {
      if (data.slot !== undefined && data.slot !== null && this.rows.some((row) => row.slot === data.slot)) continue;
      const id = `r${++this.counter}`;
      this.rows.push({ ...structuredClone(data), id });
      ids.push(id);
    }
    return { ids };
  }

  async compareAndSwap(table: string, id: string, expectedPayload: Record<string, unknown>, data: Record<string, unknown>) {
    if (this.fail) throw new Error("db down");
    this.writes.push(`compareAndSwap ${table}`);
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined || !isDeepStrictEqual(row.payload, expectedPayload)) return { ok: false };
    Object.assign(row, structuredClone(data));
    return { ok: true };
  }

  /** The paths in the stored recent-files list, newest first. */
  recentPaths(): string[] {
    const payload = this.rows.find((row) => row.slot === "recent")?.payload as { entries?: Array<{ path: string }> } | undefined;
    return (payload?.entries ?? []).map((entry) => entry.path);
  }
}

export interface Harness {
  files: FakeFiles;
  timers: FakeTimers;
  db: FakeDb;
  deps: SessionDeps;
  clock: { now: number };
}

export function harness(): Harness {
  const files = new FakeFiles();
  const timers = new FakeTimers();
  const db = new FakeDb();
  const clock = { now: Date.parse("2026-11-20T10:00:00Z") };
  return { files, timers, db, clock, deps: { files, timers, db, now: () => clock.now, autosaveDelayMs: 1000 } };
}

/** Bytes of a small workbook: A1..A3 = 1,2,3 and B1 = SUM(A1:A3). */
export async function sampleXlsx(): Promise<Uint8Array> {
  const workbook = createXlsx();
  const sheet = workbook.listSheets()[0]!.id;
  workbook.setRange(sheet, { row: 0, col: 0 }, [[1], [2], [3]]);
  workbook.setFormula(sheet, { row: 0, col: 1 }, "SUM(A1:A3)");
  workbook.recalc();
  return workbook.save();
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lets queued promise callbacks and microtasks run. */
export async function settle(): Promise<void> {
  // Serialising a workbook compresses through streams, which take several turns of the event loop.
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}
