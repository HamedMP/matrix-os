export interface Field {
  key: string;
  label: string;
  kind: "text" | "longtext" | "date" | "number" | "money" | "url" | "select";
  required?: boolean;
  options?: string[];
}
export interface Definition {
  id: string;
  name: string;
  collection: "personal" | "business";
  category: string;
  description: string;
  tagline: string;
  icon: string;
  accent: string;
  view:
    | "finance"
    | "travel"
    | "agenda"
    | "board"
    | "library"
    | "notes"
    | "habits"
    | "focus";
  entity: string;
  fields: Field[];
  services: { id: string; name: string; actions: string[] }[];
  importGoal: string;
  highlights: string[];
}
export interface Account {
  service: string;
  label: string;
  email?: string;
}
export type Connection = import("./generated-inventory").GalleryInventoryEntry;
export interface Evidence {
  id: string;
  service: string;
  label: string;
  title: string;
  url?: string;
  excerpt?: string;
  date?: string;
}
export interface OwnerRecord {
  id: string;
  rowId?: string;
  basePayload?: Record<string, unknown>;
  fields: Record<string, string | number | null>;
  scope: "personal" | "work";
  accounts: Account[];
  sources: Evidence[];
  manualFields: string[];
  updatedAt: string;
  archivedAt?: string;
}
export interface Database {
  find(
    table: string,
    options?: {
      limit?: number;
      offset?: number;
      orderBy?: Record<string, "asc" | "desc">;
    },
  ): Promise<Record<string, unknown>[]>;
  findOne?(table: string, id: string): Promise<Record<string, unknown> | null>;
  compareAndSwap?(
    table: string,
    id: string,
    expectedPayload: Record<string, unknown>,
    row: Record<string, unknown>,
  ): Promise<{ ok: boolean }>;
  insert(table: string, row: Record<string, unknown>): Promise<{ id: string }>;
  update(
    table: string,
    id: string,
    row: Record<string, unknown>,
  ): Promise<unknown>;
  onChange?(table: string, callback: () => void): () => void;
}
declare global {
  interface Window {
    MatrixOS?: {
      db?: Database;
      integrations?: () => Promise<Connection[]>;
      generate?: (context: string) => void;
      navigate?: (route: string, context?: string) => void;
    };
  }
}
