import { expect, it, vi } from 'vitest';
import { authenticatedRoutineOriginProxyProof } from '../../packages/platform/src/routine-origin-proxy.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
const legacy={clientRequestId:'req_legacy',baseRevision:0,parts:[{type:'text',text:'ordinary turn'}],selection:{instanceId:'claude_code_default',model:'fixture'},interactionMode:'default',permissionMode:'full_access'};
it('does not add a new Clerk verification dependency to an omitted-field legacy turn',async()=>{
 const clerkAuth=createClerkAuth({verifyToken:async()=>{throw new Error('unrelated failure');}});
 const verify=vi.spyOn(clerkAuth,'verify').mockRejectedValue(new Error('unrelated failure'));
 const path='/api/chats/chat_owner/turns';
 const result=await authenticatedRoutineOriginProxyProof({request:new Request(`https://app.test${path}`,{method:'POST',headers:{authorization:'Bearer synthetic-browser'},body:JSON.stringify(legacy)}),method:'POST',path,handle:'owner-pc',identity:{source:'auth',handle:'owner-pc',userId:'user_owner'},machine:{handle:'owner-pc',runtimeSlot:'primary',machineId:'machine_owner',clerkUserId:'user_owner',provisioningClass:'customer'},platformSecret:'synthetic-secret',clerkAuth});
 expect(result).toBeNull();expect(verify).not.toHaveBeenCalled();
});
