import type { PlatformDB } from '../db.js';
import { withAccountDeletionOwnerLock } from './admission.js';

interface VerifiedConnectedWebhook {
  externalUserId:string;accountId:string;user:{id:string;clerkId:string}|null;
}
/** Gateway invokes this only after checking the provider signature and bounded payload. */
export function createAccountDeletionIntegrationWebhookAdmission(options:{
  db:PlatformDB;env?:NodeJS.ProcessEnv;
  pipedream:{listAccounts(externalUserId:string):Promise<Array<{id:string}>>;revokeAccount(accountId:string):Promise<void>};
}):(input:VerifiedConnectedWebhook,persist:()=>Promise<void>)=>Promise<void> {
  const env=options.env??process.env;
  async function revokeVerifiedGrant(input:VerifiedConnectedWebhook):Promise<void> {
    const accounts=await options.pipedream.listAccounts(input.externalUserId);
    // Complete scoped inventory with no remaining accounts proves a repeated
    // completion has already been cleaned up, without deleting another owner.
    if(!accounts.length)return;
    if(accounts.length>1000 || !accounts.some(account=>account.id===input.accountId)) {
      throw Error('Integration cleanup verification unavailable');
    }
    await options.pipedream.revokeAccount(input.accountId);
  }
  return async(input,persist)=>{
    if(env.ACCOUNT_DELETION_SECRET===undefined){await persist();return;}
    // A connect link requires an existing platform user before issuance. A valid
    // provider completion with no owner mapping is therefore an orphan grant.
    // Scope it using the provider's external-owner inventory before revocation.
    const user=input.user;
    if(!user){await revokeVerifiedGrant(input);return;}
    await withAccountDeletionOwnerLock(options.db,user.clerkId,async(trx,admission)=>{
      const current=await trx.executor.selectFrom('users').select(['clerk_id','pipedream_external_id'])
        .where('id','=',user.id).executeTakeFirst();
      if(!current){await revokeVerifiedGrant(input);return;}
      if(current.clerk_id!==user.clerkId || current.pipedream_external_id!==input.externalUserId) {
        throw Error('Integration owner verification unavailable');
      }
      if(!admission.newWorkAllowed){await revokeVerifiedGrant(input);return;}
      await persist();
    },env);
  };
}
