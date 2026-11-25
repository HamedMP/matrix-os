/**
 * An in-memory stand-in for `window.MatrixOS.db` with the semantics the
 * Mail cache relies on: generated ids, unique columns, `$in` filters,
 * ordering, limits and the bulk caps.
 */
import type { MatrixOSDbFindOptions, MatrixOSDbRow } from "../../../../home/apps/_shared/matrix-os";

type Row = MatrixOSDbRow & { id: string };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  calls: string[] = [];
  failNext: string | null = null;
  private nextId = 1;

  constructor(private readonly unique: Record<string, string> = {}) {}

  private rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  private check(method: string): void {
    this.calls.push(method);
    if (this.failNext === method) {
      this.failNext = null;
      throw new Error("db down");
    }
  }

  private matches(row: Row, where: MatrixOSDbFindOptions["where"]): boolean {
    for (const [column, condition] of Object.entries(where ?? {})) {
      const value = row[column];
      if (condition !== null && typeof condition === "object") {
        if (condition.$in && !condition.$in.includes(value as never)) return false;
        if (condition.$eq !== undefined && value !== condition.$eq) return false;
      } else if (value !== condition) return false;
    }
    return true;
  }

  private assertUnique(table: string, row: MatrixOSDbRow, exceptId?: string): void {
    const column = this.unique[table];
    if (!column) return;
    if (this.rows(table).some((existing) => existing.id !== exceptId && existing[column] === row[column])) {
      throw new Error("duplicate key");
    }
  }

  async find(table: string, options: MatrixOSDbFindOptions = {}): Promise<MatrixOSDbRow[]> {
    this.check("find");
    let rows = this.rows(table).filter((row) => this.matches(row, options.where));
    const [order] = Object.entries(options.orderBy ?? {});
    if (order) {
      const [column, direction] = order;
      rows = [...rows].sort((a, b) => {
        const diff = (a[column] as number) < (b[column] as number) ? -1 : (a[column] as number) > (b[column] as number) ? 1 : 0;
        return direction === "asc" ? diff : -diff;
      });
    }
    const offset = options.offset ?? 0;
    return structuredClone(rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit));
  }

  async findOne(table: string, id: string): Promise<MatrixOSDbRow | null> {
    this.check("findOne");
    return structuredClone(this.rows(table).find((row) => row.id === id) ?? null);
  }

  async insert(table: string, data: MatrixOSDbRow): Promise<{ id: string }> {
    this.check("insert");
    this.assertUnique(table, data);
    const id = `row-${this.nextId++}`;
    this.rows(table).push({ ...structuredClone(data), id });
    return { id };
  }

  async bulkInsert(table: string, rows: MatrixOSDbRow[]): Promise<{ ids: string[] }> {
    this.check("bulkInsert");
    if (rows.length > 200) throw new Error("too many rows");
    const ids: string[] = [];
    for (const row of rows) {
      this.assertUnique(table, row);
      const id = `row-${this.nextId++}`;
      this.rows(table).push({ ...structuredClone(row), id });
      ids.push(id);
    }
    return { ids };
  }

  async update(table: string, id: string, data: MatrixOSDbRow): Promise<{ ok: true }> {
    this.check("update");
    const row = this.rows(table).find((entry) => entry.id === id);
    if (row) Object.assign(row, structuredClone(data));
    return { ok: true };
  }

  async compareAndSwap(): Promise<{ ok: boolean }> {
    throw new Error("not used");
  }

  async bulkUpdate(table: string, updates: Array<{ id: string; data: MatrixOSDbRow }>): Promise<{ ok: true }> {
    this.check("bulkUpdate");
    if (updates.length > 200) throw new Error("too many updates");
    for (const { id, data } of updates) {
      this.assertUnique(table, data, id);
      const row = this.rows(table).find((entry) => entry.id === id);
      if (row) Object.assign(row, structuredClone(data));
    }
    return { ok: true };
  }

  async delete(table: string, id: string): Promise<{ ok: true }> {
    this.check("delete");
    this.tables[table] = this.rows(table).filter((row) => row.id !== id);
    return { ok: true };
  }

  async count(table: string): Promise<number> {
    this.check("count");
    return this.rows(table).length;
  }

  async appInfo(): Promise<{ installedVersion: string | null }> {
    return { installedVersion: null };
  }

  onChange(): () => void {
    return () => undefined;
  }
}

export function mailFakeDb(): FakeDb {
  return new FakeDb({ mail_threads: "thread_key", mail_folders: "account_id", mail_snoozes: "thread_key" });
}
