import {useEffect,useRef} from "react";
import {sourceChatFromSearch} from "@matrix-os/ui/routine-origin";
/** URL is a navigation selector only; the ordinary authenticated read still owns access. */
export function useSourceChatBrowserEntry({identity,connected,switchConversation,isCurrent}:{identity:string;connected:boolean;switchConversation:(id:string)=>void;isCurrent?:()=>boolean}) {
 const consumed=useRef<string|null>(null);
 useEffect(()=>{if(!connected||isCurrent?.()===false||consumed.current===identity)return;consumed.current=identity;
  const chatId=sourceChatFromSearch(window.location.search);if(chatId)switchConversation(chatId);
 },[identity,connected,switchConversation,isCurrent]);
}
