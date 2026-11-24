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

export class FakeDb implements SessionDb {
  rows: Array<Record<string, unknown> & { id: string }> = [];
  private counter = 0;
  fail = false;

  async find(table: string, options?: { limit?: number }) {
    if (this.fail) throw new Error("db down");
    void table;
    return this.rows.slice(0, options?.limit ?? this.rows.length).map((row) => ({ ...row }));
  }

  async insert(table: string, data: Record<string, unknown>) {
    void table;
    const id = `r${++this.counter}`;
    this.rows.push({ ...data, id });
    return { id };
  }

  async update(table: string, id: string, data: Record<string, unknown>) {
    void table;
    const row = this.rows.find((entry) => entry.id === id);
    if (row !== undefined) Object.assign(row, data);
    return { ok: true };
  }

  async delete(table: string, id: string) {
    void table;
    this.rows = this.rows.filter((row) => row.id !== id);
    return { ok: true };
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
