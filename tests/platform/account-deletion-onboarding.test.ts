import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb } from './platform-db-test-helper.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { appendJourneyEvent,upsertOnboardingFirstRun,insertOnboardingFirstRunIfAbsent } from '../../packages/platform/src/db.js';
afterEach(()=>vi.unstubAllEnvs());
describe('deletion onboarding writer fence',()=>{
 it('does not recreate personal telemetry or completion rows while identity deletion retries',async()=>{
  const {db}=await createTestPlatformDb();const secret='s'.repeat(32);vi.stubEnv('ACCOUNT_DELETION_SECRET',secret);
  try{
   const repo=new AccountDeletionRepository(db.kysely,{secret});await repo.accept({clerkUserId:'user_retry',appleTokens:[]},true);
   await db.executor.updateTable('account_deletion_jobs').set({status:'processing',next_step:6}).execute();
   await appendJourneyEvent(db,{id:'journey',clerkUserId:'user_retry',fromPhase:null,toPhase:'choose',detail:null,at:new Date().toISOString()});
   const firstRun={clerkUserId:'user_retry',completedAt:new Date().toISOString(),source:'gateway' as const};
   await upsertOnboardingFirstRun(db,firstRun);await insertOnboardingFirstRunIfAbsent(db,firstRun);
   expect(await db.executor.selectFrom('onboarding_journey_events').selectAll().execute()).toEqual([]);
   expect(await db.executor.selectFrom('onboarding_first_run').selectAll().execute()).toEqual([]);
  }finally{await db.destroy();}
 });
});
