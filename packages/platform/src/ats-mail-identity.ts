import type {AtsDB} from './ats-db.js';
import {AtsDeliveryPendingError} from './ats-notifications.js';
export const isRecruitingTeam=(email:string)=>/@(?:finna\.ai|matrix-os\.com)$/i.test(email);
// Old data and out-of-order team replies are resolved immediately before external delivery.
export async function resolveAtsMailIdentity(db:AtsDB,id:string){
 return db.transaction(async trx=>{
  const original=await trx.executor.selectFrom('ats_inbox_messages').selectAll().where('id','=',id).executeTakeFirstOrThrow();
  let current=original;const visited=new Set<string>();
  for(let depth=0;depth<16;depth++){
   if(visited.has(current.message_id))throw new AtsDeliveryPendingError();visited.add(current.message_id);
   const known=current.applicant_email&&!isRecruitingTeam(current.applicant_email)?current.applicant_email:!isRecruitingTeam(current.sender_email)?current.sender_email:'';
   if(known){
    if(original.applicant_email!==known)await trx.executor.updateTable('ats_inbox_messages').set({applicant_email:known}).where('id','=',id).execute();
    return known;
   }
   if(!current.thread_id)return `unknown:${original.id}`;
   const parent=await trx.executor.selectFrom('ats_inbox_messages').selectAll().where('message_id','=',current.thread_id).executeTakeFirst();
   if(!parent)throw new AtsDeliveryPendingError();current=parent;
  }
  throw new AtsDeliveryPendingError();
 });
}
