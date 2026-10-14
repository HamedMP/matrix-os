import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb } from './native-platform-db-test-helper.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createAccountDeletionRoutes } from '../../packages/platform/src/account-deletion/routes.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

// Export composition is real. Destructive/provider adapters are never invoked.
vi.mock('../../packages/platform/src/account-deletion/adapters.js', () => ({ createAccountDeletionAdapters: vi.fn() }));
vi.mock('../../packages/platform/src/account-deletion/native-apple.js', () => ({ registerNativeAppleAuthorization: vi.fn() }));
vi.mock('../../packages/platform/src/account-deletion/admission.js', () => ({ withAccountDeletionAdmission: vi.fn() }));

const owner = 'user_export';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-10-01T12:00:00.000Z';
const authorization = { authorization: 'Bearer fixture-owner' };
const env = {
  ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_DELETION_SECRET: 's'.repeat(32), CLERK_SECRET_KEY: 'fixture',
  S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', S3_ENDPOINT: 'https://storage.example.test',
};

afterEach(() => vi.restoreAllMocks());

async function fixture(db: PlatformDB) {
  const runtime = await createConfiguredAccountDeletionRuntime({ db, env, backgroundWorkersEnabled: false });
  if (!runtime) throw new Error('Fixture export runtime missing');
  const schedule = vi.spyOn(runtime.service, 'schedule');
  const cancel = vi.spyOn(runtime.service, 'cancel');
  const app = createAccountDeletionRoutes({ ...runtime,
    verify: async token => token === 'fixture-owner' ? owner : null });
  return { runtime, app, schedule, cancel };
}

async function seedOwners(db: PlatformDB) {
  await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id,pipedream_external_id)
    VALUES (${ownerId},${owner},'export-owner','Owner','owner@example.test','PRIVATE_CONTAINER','PRIVATE_INTEGRATION'),
      (${otherId},'user_other','export-other','Other','other@example.test','FOREIGN_CONTAINER',null)`.execute(db.executor);
}

async function seedMachine(db: PlatformDB) {
  await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,provisioned_at,registration_token_hash)
    VALUES ('export-machine',${owner},'export-owner','running',${timestamp},'PRIVATE_REGISTRATION_TOKEN')`.execute(db.executor);
}

describe('ENG-287 export contract (tests first; response additions are proposed)', () => {
  it('preserves authoritative object timestamps and sizes through storage adapter, export wiring and route', async () => {
    const { db } = await createTestPlatformDb();
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      return { Contents: [{ Key: `matrixos-sync/${owner}/files/notes.txt`, LastModified: new Date(timestamp), Size: 42 }], IsTruncated: false };
    });
    const { runtime, app } = await fixture(db);
    try {
      const response = await app.request('/api/account/delete/export', { headers: authorization });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = await response.json();
      expect(send).toHaveBeenCalledOnce();
      expect(body.downloads).toEqual([expect.objectContaining({ name: 'files/notes.txt', lastModified: timestamp, sizeBytes: 42 })]);
      expect(new URL(body.downloads[0].url).searchParams.get('X-Amz-Expires')).toBe('900');
    } finally { runtime.close(); await db.destroy(); }
  });

  it('distinguishes no computer from a computer with no backed-up objects after all inventory pages', async () => {
    const { db } = await createTestPlatformDb();
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ Contents: [], IsTruncated: false }));
    const { runtime, app } = await fixture(db);
    async function inventory() {
      const pages: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      do {
        const response = await app.request('/api/account/delete/export' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { headers: authorization });
        expect(response.status).toBe(200);
        const page = await response.json();
        pages.push(page); cursor = page.nextCursor ?? null;
        if (pages.length > 10) throw new Error('Fixture inventory did not terminate');
      } while (cursor);
      return pages.at(-1)!;
    }
    try {
      const absent = await inventory();
      await seedMachine(db);
      const empty = await inventory();
      expect.soft(absent.inventoryStatus).toBe('no_computer');
      expect.soft(empty.inventoryStatus).toBe('missing_backups');
      expect.soft(empty.instructions).not.toEqual(absent.instructions);
    } finally { runtime.close(); await db.destroy(); }
  });

  it('includes proven portable groups and excludes foreign records and protected fields', async () => {
    const { db } = await createTestPlatformDb();
    await seedOwners(db); await seedMachine(db);
    await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,provisioned_at)
      VALUES ('foreign-machine','user_other','export-other','running',${timestamp})`.execute(db.executor);
    await sql`INSERT INTO apps_registry (id,name,slug,author_id,created_at,updated_at,is_public)
      VALUES ('owner-app','Owner app','owner-app',${ownerId},${timestamp},${timestamp},false),
        ('foreign-app','FOREIGN_APP','foreign-app',${otherId},${timestamp},${timestamp},false)`.execute(db.executor);
    await sql`INSERT INTO app_ratings (app_id,user_id,rating,review,created_at)
      VALUES ('owner-app',${ownerId},5,'OWNER_REVIEW',${timestamp}),('owner-app',${otherId},1,'FOREIGN_REVIEW',${timestamp})`.execute(db.executor);
    await sql`INSERT INTO app_installs (app_id,user_id,installed_at)
      VALUES ('owner-app',${ownerId},${timestamp}),('foreign-app',${otherId},${timestamp})`.execute(db.executor);
    await sql`INSERT INTO ai_funded_credit_ledger (entry_id,owner_id,machine_id,runtime_slot,kind,amount_microusd,source_reference,created_at)
      VALUES ('owner-credit',${owner},'export-machine','primary','addon_grant',2000000,'PRIVATE_BILLING_REFERENCE',${timestamp}),
        ('foreign-credit','user_other','foreign-machine','primary','addon_grant',1000000,'FOREIGN_REFERENCE',${timestamp})`.execute(db.executor);
    await sql`INSERT INTO onboarding_journey_events (id,clerk_user_id,to_phase,at)
      VALUES ('owner-journey',${owner},'ready',${timestamp}),('foreign-journey','user_other','FOREIGN_PHASE',${timestamp})`.execute(db.executor);
    const { runtime, app } = await fixture(db);
    try {
      const response = await app.request('/api/account/delete/export/platform', { headers: authorization });
      expect(response.status).toBe(200);
      const body = await response.json();
      // Proposed JSON group names: review the protected-field projection before implementation.
      expect.soft(body.apps).toEqual([expect.objectContaining({ id: 'owner-app', name: 'Owner app' })]);
      expect.soft(body.appRatings).toEqual([expect.objectContaining({ review: 'OWNER_REVIEW' })]);
      expect.soft(body.appInstalls).toEqual([expect.objectContaining({ app_id: 'owner-app' })]);
      expect.soft(body.creditLedger).toEqual([expect.objectContaining({ entry_id: 'owner-credit', amount_microusd: 2000000 })]);
      expect.soft(body.onboardingJourney).toEqual([expect.objectContaining({ id: 'owner-journey' })]);
      expect(JSON.stringify(body)).not.toMatch(/FOREIGN_|foreign-app|foreign-journey|foreign-credit|foreign-machine|PRIVATE_/);
    } finally { runtime.close(); await db.destroy(); }
  });

  it('exports more than 10k owner posts in bounded pages and resumes a saved cursor without duplicates', async () => {
    const { db } = await createTestPlatformDb();
    await seedOwners(db);
    await sql`INSERT INTO social_posts (id,author_id,content,type,created_at)
      SELECT 'post-' || lpad(n::text,5,'0'),${ownerId},'owner-' || n,'text',${timestamp} FROM generate_series(1,10005) n`.execute(db.executor);
    await sql`INSERT INTO social_posts (id,author_id,content,type,created_at)
      VALUES ('foreign-post',${otherId},'FOREIGN_CONTENT','text',${timestamp})`.execute(db.executor);
    const { runtime, app, schedule, cancel } = await fixture(db);
    try {
      async function read(cursor?: string) {
        const response = await app.request('/api/account/delete/export/platform' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { headers: authorization });
        expect(response.status).toBe(200);
        return response.json();
      }
      const first = await read();
      expect(first.posts.length).toBeGreaterThan(0);
      expect(first.posts.length).toBeLessThanOrEqual(1000);
      expect(first.nextCursor).toEqual(expect.any(String));
      const replay = await read(first.nextCursor);
      expect((await read(first.nextCursor)).posts).toEqual(replay.posts);
      const ids: string[] = first.posts.map((row: { id: string }) => row.id);
      let page = replay;
      for (let requests = 0; requests < 100; requests++) {
        expect(page.posts.length).toBeLessThanOrEqual(1000);
        ids.push(...page.posts.map((row: { id: string }) => row.id));
        if (!page.nextCursor) break;
        page = await read(page.nextCursor);
        if (requests === 99) throw new Error('Fixture record export did not terminate');
      }
      expect(ids).toHaveLength(10005);
      expect(new Set(ids).size).toBe(10005);
      expect(ids).not.toContain('foreign-post');
      expect(schedule).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    } finally { runtime.close(); await db.destroy(); }
  });

  it('allows both exports without scheduling deletion and after cancellation', async () => {
    const { db } = await createTestPlatformDb();
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ Contents: [], IsTruncated: false }));
    const { runtime, app, schedule, cancel } = await fixture(db);
    try {
      for (const state of ['none', 'cancelled'] as const) {
        vi.spyOn(runtime.service, 'get').mockResolvedValue({ status: state, completesBy: null, billingStopped: false });
        for (const path of ['/api/account/delete/export', '/api/account/delete/export/platform']) {
          expect((await app.request(path, { headers: authorization })).status).toBe(200);
        }
      }
      expect(schedule).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
      expect(await db.executor.selectFrom('account_deletion_jobs').selectAll().execute()).toEqual([]);
    } finally { runtime.close(); await db.destroy(); }
  });
});
