import { randomBytes } from 'node:crypto';
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
  registrationToken: string;
  serverName?: string;
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
  const { db, homeserverUrl, registrationToken, serverName = 'matrix-os.com' } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  async function registerAndLogin(
    username: string,
    displayname: string,
  ): Promise<{ userId: string; accessToken: string }> {
    // Password is used once for register+login, then discarded. The access_token
    // is stored durably in the DB. If it expires, the user can be re-provisioned.
    const password = randomBytes(32).toString('hex');

    const regRes = await fetchFn(`${homeserverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        username,
        password,
        initial_device_display_name: displayname,
        auth: { type: 'm.login.registration_token', token: registrationToken },
      }),
    });

    if (!regRes.ok) {
      const err = (await regRes.json().catch(() => ({}))) as { errcode?: string };
      throw new Error(`Failed to register Matrix user ${username}: ${err.errcode ?? regRes.status}`);
    }

    const regBody = (await regRes.json()) as { user_id?: string; access_token?: string };

    if (!regBody.user_id) {
      throw new Error(`Matrix register: missing user_id in response for ${username}`);
    }

    if (regBody.access_token) {
      return { userId: regBody.user_id, accessToken: regBody.access_token };
    }

    const loginRes = await fetchFn(`${homeserverUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
        initial_device_display_name: displayname,
      }),
    });

    if (!loginRes.ok) {
      throw new Error(`Failed to login Matrix user ${username} after registration`);
    }

    const loginBody = (await loginRes.json()) as { user_id: string; access_token: string };
    return { userId: loginBody.user_id, accessToken: loginBody.access_token };
  }

  return {
    async provisionUser(handle) {
      const human = await registerAndLogin(handle, handle);
      let ai;
      try {
        ai = await registerAndLogin(`${handle}_ai`, `${handle} (AI)`);
      } catch (err) {
        console.error(`[matrix] AI registration failed for ${handle}, human account @${handle}:${serverName} is orphaned`);
        throw err;
      }

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
