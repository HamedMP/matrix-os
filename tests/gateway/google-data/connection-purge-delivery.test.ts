import { describe,expect,it,vi } from 'vitest';
import { createTestIntegrationDb } from '../../integrations/native-integration-db-test-helper.js';
import { createIntegrationRoutes } from '../../../packages/gateway/src/integrations/routes.js';
import { profileInput,consentInput } from './fixtures.js';
describe('Gmail grant and purge delivery composition',()=>{
 it('queues Pipedream Gmail cleanup atomically with disconnect, before losing live account ownership',async()=>{
  const {db}=await createTestIntegrationDb();try{
   await db.googleData!.purgeDelivery.pinRuntime('owner-one','machine-one');
   const user=await db.createUser({clerkId:'owner-one',handle:'owner-one',displayName:'Owner',email:'owner@example.test',containerId:'owner-container'});
   const account=await db.connectService({userId:user.id,service:'gmail',pipedreamAccountId:'apn_synthetic',accountLabel:'Mail',scopes:[]});
   const profile=await db.googleData!.repository.reviewProfile(profileInput(),0);
   const consent=await db.googleData!.repository.recordConsent(consentInput(profile.id,{googleAccountId:account.id}),0);
   const app=createIntegrationRoutes({db,pipedream:{revokeAccount:vi.fn(async()=>undefined)} as never,webhookSecret:'synthetic',resolveUserId:async()=>user.id});
   expect((await app.request(`/${account.id}`,{method:'DELETE'})).status).toBe(200);
   expect(await db.googleData!.purgeDelivery.poll('owner-one','machine-one')).toMatchObject([{googleAccountId:account.id,consentId:consent.id}]);
   expect((await db.googleData!.repository.snapshot({ownerId:'owner-one',googleAccountId:account.id,purposeId:consent.input.purposeId,profileId:profile.id})).consent?.status).toBe('revoked');
  }finally{await db.destroy();}
 });
});
