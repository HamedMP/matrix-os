import { eq } from 'drizzle-orm';
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import type { PlatformDB } from './db.js';

// --- Schema ---

export const matrixUsers = sqliteTable(
  'matrix_users',
  {
    handle: text('handle').primaryKey(),
    humanMatrixId: text('human_matrix_id').notNull(),
    aiMatrixId: text('ai_matrix_id').notNull(),
    humanAccessToken: text('human_access_token').notNull(),
    aiAccessToken: text('ai_access_token').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_matrix_human_id').on(table.humanMatrixId),
    index('idx_matrix_ai_id').on(table.aiMatrixId),
  ],
);

export type MatrixUserRecord = typeof matrixUsers.$inferSelect;

// --- Migration ---

export function runMatrixUserMigrations(sqlite: { prepare(sql: string): { run(): unknown } }): void {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS matrix_users (
      handle TEXT PRIMARY KEY,
      human_matrix_id TEXT NOT NULL,
      ai_matrix_id TEXT NOT NULL,
      human_access_token TEXT NOT NULL,
      ai_access_token TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_matrix_human_id ON matrix_users(human_matrix_id)'
  ).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_matrix_ai_id ON matrix_users(ai_matrix_id)'
  ).run();
}

// --- CRUD ---

export function getMatrixUser(db: PlatformDB, handle: string): MatrixUserRecord | null {
  return db.select().from(matrixUsers).where(eq(matrixUsers.handle, handle)).get() ?? null;
}

export function listMatrixUsers(db: PlatformDB): MatrixUserRecord[] {
  return db.select().from(matrixUsers).all();
}

function insertMatrixUser(
  db: PlatformDB,
  record: Omit<MatrixUserRecord, 'createdAt'>,
): void {
  db.insert(matrixUsers).values({
    ...record,
    createdAt: new Date().toISOString(),
  }).run();
}

function deleteMatrixUser(db: PlatformDB, handle: string): void {
  db.delete(matrixUsers).where(eq(matrixUsers.handle, handle)).run();
}

// --- Provisioner ---

export interface MatrixProvisionerConfig {
  db: PlatformDB;
  homeserverUrl: string;
  adminToken: string;
  fetch?: typeof globalThis.fetch;
}

export interface ProvisionResult {
  humanMatrixId: string;
  aiMatrixId: string;
  humanAccessToken: string;
  aiAccessToken: string;
}

export interface MatrixProvisioner {
  provisionUser(handle: string): Promise<ProvisionResult>;
  deprovisionUser(handle: string): void;
}

export function createMatrixProvisioner(config: MatrixProvisionerConfig): MatrixProvisioner {
  const { db, homeserverUrl, adminToken } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;

  async function registerUser(
    matrixId: string,
    displayname: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const url = `${homeserverUrl}/_synapse/admin/v2/users/${matrixId}`;
    const res = await fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        displayname,
        password: `matrixos_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        admin: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to provision Matrix user ${matrixId}`);
    }

    const body = (await res.json()) as { user_id: string; access_token: string };
    return { userId: body.user_id, accessToken: body.access_token };
  }

  return {
    async provisionUser(handle) {
      const humanId = `@${handle}:matrix-os.com`;
      const aiId = `@${handle}_ai:matrix-os.com`;

      const human = await registerUser(humanId, handle);
      const ai = await registerUser(aiId, `${handle} (AI)`);

      const result: ProvisionResult = {
        humanMatrixId: human.userId,
        aiMatrixId: ai.userId,
        humanAccessToken: human.accessToken,
        aiAccessToken: ai.accessToken,
      };

      insertMatrixUser(db, {
        handle,
        humanMatrixId: result.humanMatrixId,
        aiMatrixId: result.aiMatrixId,
        humanAccessToken: result.humanAccessToken,
        aiAccessToken: result.aiAccessToken,
      });

      return result;
    },

    deprovisionUser(handle) {
      deleteMatrixUser(db, handle);
    },
  };
}
