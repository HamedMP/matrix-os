import { RoutineChatReceiptPartSchema, type CanonicalChatMessage, type RoutineChatReceiptPart } from "@matrix-os/contracts";
/** Never infer provenance from text, model metadata, a request prefix, or a live Run. */
export function routineReceiptMessage(message:CanonicalChatMessage,chatId:string|undefined):RoutineChatReceiptPart|undefined {
  if(!chatId||message.chatId!==chatId||message.role!=="system"||message.purpose!=="system"||message.state!=="committed"||message.turnId||message.runId) return;
  const parts=message.parts.filter(part=>part.type==="routine_receipt");
  if(parts.length!==1)return;
  const result=RoutineChatReceiptPartSchema.safeParse(parts[0]);return result.success?result.data:undefined;
}
export function routineReceiptOutcome(receipt:RoutineChatReceiptPart):string {
  if(receipt.stop==="unconfirmed")return "Cancellation requested; execution stop unconfirmed";
  return ({completed:"Completed",failed:"Failed",cancelled:"Cancelled",unknown:"Outcome unconfirmed",missed:"Missed",skipped:"Skipped"})[receipt.status];
}
