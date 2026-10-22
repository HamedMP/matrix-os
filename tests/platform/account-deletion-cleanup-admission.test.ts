import { describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
vi.mock('../../packages/platform/src/account-deletion/admission.js',()=>({getAccountDeletionAdmission:vi.fn(async()=>({runtimeAccess:'blocked'})),
 withAccountDeletionOwnerLock:vi.fn(async(_db,_owner,work)=>work({}, {newWorkAllowed:false,runtimeAccess:'blocked'}))}));
import { createAccountDeletionMutationGuard } from '../../packages/platform/src/account-deletion/integration-admission.js';
describe('cleanup during pending account deletion',()=>{
 it('allows only an explicitly trusted cleanup path while new mutations stay blocked',async()=>{
  const app=new Hono();app.use('*',createAccountDeletionMutationGuard({db:{} as never,env:{ACCOUNT_DELETION_SECRET:'synthetic'},
   resolveOwner:()=> 'owner_one',isCleanup:c=>c.req.path==='/trusted-cleanup'}));
  app.post('*',c=>c.json({ok:true}));
  expect((await app.request('/trusted-cleanup',{method:'POST'})).status).toBe(200);
  expect((await app.request('/new-work',{method:'POST'})).status).toBe(409);
 });
});
