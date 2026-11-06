import {CanonicalChatIdSchema} from "@matrix-os/contracts";
/** Select the actual canonical Chat and leave any owning project/Agents route. */
export function openRoutineHistory(chatId:string,selectChat:(id:string)=>void,showChat:()=>void) {
 selectChat(CanonicalChatIdSchema.parse(chatId));showChat();
}
