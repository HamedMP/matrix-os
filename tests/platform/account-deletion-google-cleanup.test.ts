import { describe,expect,it } from 'vitest';
import { sql } from 'kysely';
import { createTestPlatformDb,destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { profileInput,consentInput,now } from '../gateway/google-data/fixtures.js';
describe('confirmed runtime deletion and Google metadata erasure',()=>{
 it('erases owned Google registry and pending delivery metadata only after existing runtime cleanup gates',async()=>{
  const {db}=await createTestPlatformDb();try{
   const repo=createGoogleDataRepository(db.executor,{now:()=>now});await repo.migrate();
   const owned=await repo.reviewProfile(profileInput(),0);await repo.recordConsent(consentInput(owned.id),0);await repo.revokeAccount('owner-one',consentInput(owned.id).googleAccountId);
   const other=await repo.reviewProfile({...profileInput(),ownerId:'other-owner'},0);
   await eraseOwnerPlatformData(db,'owner-one');
   expect((await sql`SELECT id FROM google_data_profiles WHERE owner_id='owner-one'`.execute(db.executor)).rows).toEqual([]);
   expect((await sql`SELECT id FROM google_data_purge_commands WHERE owner_id='owner-one'`.execute(db.executor)).rows).toEqual([]);
   expect((await sql`SELECT id FROM google_data_profiles WHERE id=${other.id}`.execute(db.executor)).rows).toHaveLength(1);
  }finally{await destroyTestPlatformDb(db);}
 });
});
