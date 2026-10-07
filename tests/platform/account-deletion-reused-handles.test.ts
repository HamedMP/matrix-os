import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import { createTestPlatformDb } from './platform-db-test-helper.js';

const owner = 'user_historical';
const other = 'user_current';
const reused = 'reused_handle';
const ownHandle = 'owner_identity';
const ownPhoneId = `PN${'1'.repeat(32)}`;
const otherPhoneId = `PN${'2'.repeat(32)}`;
type Claim = 'identity' | 'legacy container' | 'active runtime';
const claims: Claim[] = ['identity', 'legacy container', 'active runtime'];

async function fixture(claim: Claim) {
  const { db } = await createTestPlatformDb();
  await sql`INSERT INTO users(id,clerk_id,handle,display_name,email,container_id) VALUES
    ('11111111-1111-4111-8111-111111111111',${owner},${ownHandle},'Owner','owner@example.test','owner-container'),
    ('22222222-2222-4222-8222-222222222222',${other},${claim === 'identity' ? reused : 'neighbor_identity'},
      'Neighbor','neighbor@example.test','neighbor-container')`.execute(db.executor);
  // Deleted slots no longer reserve handles; another account may claim this
  // historical handle through any authoritative identity/runtime directory.
  await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,runtime_slot,status,deleted_at,provisioned_at) VALUES
    ('owner_old',${owner},${reused},'old','deleted','2026-10-01','2026-10-01'),
    ('owner_primary',${owner},${ownHandle},'primary','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
  if (claim === 'legacy container') {
    await sql`INSERT INTO containers(handle,clerk_user_id,port,shell_port,status,created_at,last_active)
      VALUES (${reused},${other},20000,21000,'running','2026-10-01','2026-10-01')`.execute(db.executor);
  }
  if (claim === 'active runtime') {
    await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,runtime_slot,status,provisioned_at)
      VALUES ('neighbor_active',${other},${reused},'primary','running','2026-10-01')`.execute(db.executor);
  }
  await sql`INSERT INTO matrix_users(handle,human_matrix_id,ai_matrix_id,human_access_token,ai_access_token,created_at) VALUES
    (${ownHandle},'@owner:example.test','@owner-ai:example.test','owner-human-token','owner-ai-token','2026-10-01'),
    (${reused},'@neighbor:example.test','@neighbor-ai:example.test','neighbor-human-token','neighbor-ai-token','2026-10-01')`.execute(db.executor);
  await sql`INSERT INTO port_assignments(port,handle) VALUES (30000,${ownHandle}),(30001,${reused})`.execute(db.executor);
  return db;
}

describe('reused historical runtime handles belong to their current claimant', () => {
  it.each(claims)('preserves neighboring Matrix credentials and port claimed by another %s', async claim => {
    const db = await fixture(claim);
    try {
      await eraseOwnerPlatformData(db, owner);

      expect(await db.executor.selectFrom('matrix_users').select(['handle', 'human_access_token', 'ai_access_token']).execute())
        .toEqual([{ handle: reused, human_access_token: 'neighbor-human-token', ai_access_token: 'neighbor-ai-token' }]);
      expect(await db.executor.selectFrom('port_assignments').selectAll().orderBy('port').execute())
        .toEqual([{ port: 30000, handle: null }, { port: 30001, handle: reused }]);
      expect(await db.executor.selectFrom('user_machines').select('machine_id').where('clerk_user_id', '=', owner).execute()).toEqual([]);
      expect(await db.executor.selectFrom('users').select('clerk_id').execute()).toEqual([{ clerk_id: other }]);
      if (claim === 'active runtime') {
        expect(await db.executor.selectFrom('user_machines').select(['machine_id', 'handle']).execute())
          .toEqual([{ machine_id: 'neighbor_active', handle: reused }]);
      }
      if (claim === 'legacy container') {
        expect(await db.executor.selectFrom('containers').select(['clerk_user_id', 'handle']).execute())
          .toEqual([{ clerk_user_id: other, handle: reused }]);
      }
    } finally { await db.destroy(); }
  }, 30_000);

  it.each(claims)('revokes only owner Matrix sessions and voice numbers when another %s claims the historical handle', async claim => {
    const db = await fixture(claim);
    try {
      const matrixTokens: string[] = [];
      const deletedPhones: string[] = [];
      const publicBaseUrl = 'https://app.example.test';
      const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (url.origin === 'https://matrix.example.test' && url.pathname === '/_matrix/client/v3/logout/all') {
          matrixTokens.push(new Headers(init?.headers).get('Authorization')!);
          return new Response(null, { status: 200 });
        }
        if (url.origin === 'https://api.twilio.com' && init?.method === 'DELETE') {
          deletedPhones.push(url.pathname.split('/').at(-1)!.replace('.json', ''));
          return new Response(null, { status: 204 });
        }
        if (url.origin === 'https://api.twilio.com' && url.pathname.endsWith('/IncomingPhoneNumbers.json')) {
          return Response.json({ incoming_phone_numbers: [
            { sid: ownPhoneId, voice_url: `${publicBaseUrl}/voice/webhook/twilio?handle=${ownHandle}` },
            { sid: otherPhoneId, voice_url: `${publicBaseUrl}/voice/webhook/twilio?handle=${reused}` },
          ], next_page_uri: null });
        }
        throw new Error('Unexpected fixture request');
      });
      const adapters = createAccountDeletionAdapters({ db, clerkSecretKey: 'fixture-clerk-key', r2PrefixRoot: 'matrixos-sync',
        matrixHomeserverUrl: 'https://matrix.example.test',
        twilio: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'fixture-voice-key', publicBaseUrl }, fetch: request });

      await adapters.integrations({ clerkUserId: owner, appleTokens: [] });

      expect(matrixTokens).toEqual(['Bearer owner-human-token', 'Bearer owner-ai-token']);
      expect(deletedPhones).toEqual([ownPhoneId]);
      expect(await db.executor.selectFrom('matrix_users').select('handle').orderBy('handle').execute())
        .toEqual([{ handle: ownHandle }, { handle: reused }]);
    } finally { await db.destroy(); }
  }, 30_000);
});
