import { randomBytes } from 'node:crypto';
import type { PlatformDB } from './db.js';

const MATRIX_FETCH_TIMEOUT_MS = 10_000;

export interface MatrixUserRecord {
  handle: string;
  humanMatrixId: string;
  aiMatrixId: string;
  humanAccessToken: string;
  aiAccessToken: string;
  createdAt: string;
}

function mapMatrixUser(row: {
  handle: string;
  human_matrix_id: string;
  ai_matrix_id: string;
  human_access_token: string;
  ai_access_token: string;
  created_at: string;
}): MatrixUserRecord {
  return {
    handle: row.handle,
    humanMatrixId: row.human_matrix_id,
    aiMatrixId: row.ai_matrix_id,
    humanAccessToken: row.human_access_token,
    aiAccessToken: row.ai_access_token,
    createdAt: row.created_at,
  };
}

export async function getMatrixUser(db: PlatformDB, handle: string): Promise<MatrixUserRecord | null> {
  await db.ready;
  const row = await db.executor.selectFrom('matrix_users').selectAll().where('handle', '=', handle).executeTakeFirst();
  return row ? mapMatrixUser(row) : null;
}

export async function listMatrixUsers(db: PlatformDB): Promise<MatrixUserRecord[]> {
  await db.ready;
  const rows = await db.executor.selectFrom('matrix_users').selectAll().execute();
  return rows.map(mapMatrixUser);
}

async function insertMatrixUser(
  db: PlatformDB,
  record: Omit<MatrixUserRecord, 'createdAt'>,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('matrix_users')
    .values({
      handle: record.handle,
      human_matrix_id: record.humanMatrixId,
      ai_matrix_id: record.aiMatrixId,
      human_access_token: record.humanAccessToken,
      ai_access_token: record.aiAccessToken,
      created_at: new Date().toISOString(),
    })
    .execute();
}

async function deleteMatrixUser(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('matrix_users').where('handle', '=', handle).execute();
}

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
  deprovisionUser(handle: string): Promise<void>;
}

export function createMatrixProvisioner(config: MatrixProvisionerConfig): MatrixProvisioner {
  const { db, homeserverUrl, registrationToken, serverName = 'matrix-os.com' } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  async function registerAndLogin(
    username: string,
    displayname: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const password = randomBytes(32).toString('hex');

    const regRes = await fetchFn(`${homeserverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: jsonHeaders,
      signal: AbortSignal.timeout(MATRIX_FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        username,
        password,
        initial_device_display_name: displayname,
        auth: { type: 'm.login.registration_token', token: registrationToken },
      }),
    });

    if (!regRes.ok) {
      let err: { errcode?: string } = {};
      try {
        err = (await regRes.json()) as { errcode?: string };
      } catch (parseErr: unknown) {
        console.warn('[matrix] Failed to parse registration error response:', parseErr instanceof Error ? parseErr.message : String(parseErr));
      }
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
      signal: AbortSignal.timeout(MATRIX_FETCH_TIMEOUT_MS),
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

      await insertMatrixUser(db, {
        handle,
        humanMatrixId: result.humanMatrixId,
        aiMatrixId: result.aiMatrixId,
        humanAccessToken: result.humanAccessToken,
        aiAccessToken: result.aiAccessToken,
      });

      return result;
    },

    async deprovisionUser(handle) {
      await deleteMatrixUser(db, handle);
    },
  };
}
