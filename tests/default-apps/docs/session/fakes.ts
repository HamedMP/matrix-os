/**
 * Fakes of the `window.MatrixOS` members the Docs session uses: an in-memory
 * files bridge with versions and a table store. They follow the contract in
 * home/apps/_shared/matrix-os.d.ts, including the `BridgeFileError` shape.
 */

import type {
  BridgeFileContent,
  BridgeFileErrorCode,
  BridgeFileStat,
  BridgeFileWriteOptions,
  BridgeFileWriteResult,
  MatrixOSDbFindOptions,
  MatrixOSDbRow,
} from "../../../../home/apps/_shared/matrix-os";

export function bridgeError(code: BridgeFileErrorCode): Error {
  const error = new Error("The file request failed.") as Error & { code: BridgeFileErrorCode };
  error.name = "BridgeFileError";
  error.code = code;
  return error;
}

interface StoredFile {
  bytes: Uint8Array;
  version: string;
}

export interface FakeFiles {
  read(path: string): Promise<BridgeFileContent>;
  write(path: string, bytes: Uint8Array, options: BridgeFileWriteOptions): Promise<BridgeFileWriteResult>;
  stat(path: string): Promise<BridgeFileStat>;
  /** Puts a file in place as another writer would: the version changes. */
  put(path: string, bytes: Uint8Array): string;
  bytes(path: string): Uint8Array | null;
  has(path: string): boolean;
  /** The next call of `method` rejects with this code. */
  failNext(method: "read" | "write" | "stat", code: BridgeFileErrorCode): void;
  /** Every write waits for the returned release function to be called. */
  holdWrites(): () => void;
  readonly writes: Array<{ path: string; ifVersion: string | null; size: number }>;
  readonly reads: string[];
}

export function createFakeFiles(initial: Record<string, Uint8Array> = {}): FakeFiles {
  const store = new Map<string, StoredFile>();
  let counter = 0;
  const failures = new Map<string, BridgeFileErrorCode>();
  let gate: Promise<void> | null = null;
  const nextVersion = () => `v${++counter}`;
  for (const [path, bytes] of Object.entries(initial)) store.set(path, { bytes, version: nextVersion() });
  const takeFailure = (method: string): void => {
    const code = failures.get(method);
    if (code === undefined) return;
    failures.delete(method);
    throw bridgeError(code);
  };
  const files: FakeFiles = {
    writes: [],
    reads: [],
    async read(path) {
      files.reads.push(path);
      takeFailure("read");
      const file = store.get(path);
      if (file === undefined) throw bridgeError("not_found");
      return { path, bytes: file.bytes.slice(), size: file.bytes.length, version: file.version, mimeType: "application/octet-stream" };
    },
    async write(path, bytes, options) {
      files.writes.push({ path, ifVersion: options.ifVersion, size: bytes.length });
      if (gate !== null) await gate;
      takeFailure("write");
      const file = store.get(path);
      if (options.ifVersion === null ? file !== undefined : file === undefined || file.version !== options.ifVersion) {
        throw bridgeError("version_conflict");
      }
      const version = nextVersion();
      store.set(path, { bytes: bytes.slice(), version });
      return { path, version, size: bytes.length, modifiedAt: "2026-11-23T10:00:00.000Z" };
    },
    async stat(path) {
      takeFailure("stat");
      const file = store.get(path);
      if (file === undefined) throw bridgeError("not_found");
      return { path, size: file.bytes.length, modifiedAt: "2026-11-23T10:00:00.000Z", version: file.version };
    },
    put(path, bytes) {
      const version = nextVersion();
      store.set(path, { bytes: bytes.slice(), version });
      return version;
    },
    bytes: (path) => store.get(path)?.bytes ?? null,
    has: (path) => store.has(path),
    failNext(method, code) {
      failures.set(method, code);
    },
    holdWrites() {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
  return files;
}

export interface FakeDb {
  find(table: string, options?: MatrixOSDbFindOptions): Promise<MatrixOSDbRow[]>;
  insert(table: string, data: MatrixOSDbRow): Promise<{ id: string }>;
  update(table: string, id: string, data: MatrixOSDbRow): Promise<{ ok: true }>;
  delete(table: string, id: string): Promise<{ ok: true }>;
  rows(table: string): MatrixOSDbRow[];
  /** The next call of any method rejects. */
  failNext(): void;
}

export function createFakeDb(): FakeDb {
  const tables = new Map<string, MatrixOSDbRow[]>();
  let counter = 0;
  let fail = false;
  const rowsOf = (table: string): MatrixOSDbRow[] => {
    let rows = tables.get(table);
    if (rows === undefined) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  };
  const guard = (): void => {
    if (!fail) return;
    fail = false;
    throw new Error("db unavailable");
  };
  return {
    async find(table, options = {}) {
      guard();
      let rows = rowsOf(table).filter((row) =>
        Object.entries(options.where ?? {}).every(([column, expected]) => row[column] === expected),
      );
      for (const [column, direction] of Object.entries(options.orderBy ?? {})) {
        rows = [...rows].sort((a, b) => {
          const order = String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
          return direction === "asc" ? order : -order;
        });
      }
      const offset = options.offset ?? 0;
      return rows.slice(offset, offset + (options.limit ?? rows.length)).map((row) => ({ ...row }));
    },
    async insert(table, data) {
      guard();
      const id = `row${++counter}`;
      rowsOf(table).push({ ...data, id });
      return { id };
    },
    async update(table, id, data) {
      guard();
      const row = rowsOf(table).find((candidate) => candidate.id === id);
      if (row !== undefined) Object.assign(row, data);
      return { ok: true };
    },
    async delete(table, id) {
      guard();
      const rows = rowsOf(table);
      const at = rows.findIndex((candidate) => candidate.id === id);
      if (at >= 0) rows.splice(at, 1);
      return { ok: true };
    },
    rows: (table) => rowsOf(table).map((row) => ({ ...row })),
    failNext() {
      fail = true;
    },
  };
}
