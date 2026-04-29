interface MatrixOSDb {
  find(table: string, opts?: { orderBy?: Record<string, "asc" | "desc"> }): Promise<unknown[]>;
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<{ ok?: boolean }>;
  delete(table: string, id: string): Promise<{ ok?: boolean }>;
  onChange?(table: string, callback: () => void): () => void;
}

interface MatrixOS {
  db?: MatrixOSDb;
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<void>;
}

declare global {
  interface Window {
    MatrixOS?: MatrixOS;
  }
}

export {};
