interface MatrixOSDb {
  appInfo?(): Promise<{ installedVersion: string | null }>;
  find(table: string, opts?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>[]>;
  findOne(table: string, id: string): Promise<Record<string, unknown> | null>;
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  bulkInsert(table: string, rows: Array<Record<string, unknown>>): Promise<{ ids: string[] }>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  bulkUpdate(table: string, updates: Array<{ id: string; data: Record<string, unknown> }>): Promise<{ ok: boolean }>;
  delete(table: string, id: string): Promise<{ ok: boolean }>;
  count(table: string, filter?: Record<string, unknown>): Promise<number>;
  onChange(table: string, callback: (e: { table: string }) => void): () => void;
}
interface MatrixOS {
  db?: MatrixOSDb;
  theme?: Record<string, string>;
  app?: { name: string };
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<void>;
}
declare global {
  interface Window { MatrixOS?: MatrixOS; }
}
export {};
