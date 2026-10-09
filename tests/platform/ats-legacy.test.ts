import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { importLegacyCandidate } from '../../packages/platform/src/ats-legacy.js';
import { getAtsApplication, transitionAtsApplication } from '../../packages/platform/src/ats-repository.js';

let db: AtsDB;
beforeEach(async () => { ({ db } = await createTestAtsDb()); });
afterEach(async () => { await destroyTestAtsDb(db); });
const at = '2026-10-09T10:00:00.000Z';
const input = { legacyKey: 'owner:candidate1', name: 'Ada', email: 'ada@example.com', roleSlug: 'founding-engineer', stage: 'screening' as const, disposition: 'active' as const, summary: 'Existing recruiting history', createdAt: at, notes: [{ body: 'Previously contacted', createdAt: at }], emails: [], attachments: [] };
it('imports candidate history once with no fabricated consent or Slack flood', async () => {
  const first = await importLegacyCandidate(db, input, 'user_owner', at);
  const replay = await importLegacyCandidate(db, input, 'user_owner', at);
  expect(replay.id).toBe(first.id);
  const detail = await getAtsApplication(db, first.id);
  expect(detail?.stage).toBe('screening');
  expect(detail?.consentAt).toBeNull();
  expect(detail?.notes).toHaveLength(2);
  expect(await db.executor.selectFrom('ats_notification_outbox').selectAll().execute()).toHaveLength(0);
});
it('never resets reviewer edits when a historical import is replayed', async () => {
  const first = await importLegacyCandidate(db, input, 'user_owner', at);
  await transitionAtsApplication(db, { applicationId: first.id, stage: 'offer', disposition: 'active', reason: null, baseRevision: first.revision, actorId: 'user_reviewer', at });
  await importLegacyCandidate(db, input, 'user_owner', at);
  expect((await getAtsApplication(db, first.id))?.stage).toBe('offer');
});
