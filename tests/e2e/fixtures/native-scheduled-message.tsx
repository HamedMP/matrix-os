import React from "react";
import { createRoot } from "react-dom/client";
import "../../../packages/ui/src/chat-agents/chat-agents.css";
import { ChatApp } from "../../../shell/src/components/ChatApp";
import { ConversationTranscript } from "../../../desktop/src/renderer/src/components/conversation/transcript";
import { canonicalChatPresentation } from "../../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../../shell/src/lib/canonical-chat-terminal-notices";
import { nativeScheduledMessageFixture } from "../../helpers/native-scheduled-message-fixture";

const detail = nativeScheduledMessageFixture();
const surface = document.documentElement.dataset.surface;
if (document.documentElement.dataset.variant === "manual") {
  detail.messages[0]!.role = "user";
  detail.messages[0]!.purpose = "ai_request";
  detail.turns[0]!.clientRequestId = "req_manual";
}
if(document.documentElement.dataset.variant === "receipt") detail.messages.push({...detail.messages[0]!,id:"msg_real_receipt",seq:3,turnId:undefined,runId:undefined,parts:[{type:"text",text:"Committed routine result"},{type:"routine_receipt",engine:"matrix",kind:"output",routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"unknown",scheduledFor:detail.messages[0]!.createdAt,canonicalChatId:"chat_executor",canonicalTaskId:"task_real_execution",model:"gpt-6-luna"}]});
const openChat=(id:string)=>{document.documentElement.dataset.openChat=id;};
const noop = () => undefined;
createRoot(document.getElementById("root")!).render(
  surface === "electron"
    ? <ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: noop, openChat }}/>
    : <ChatApp mobile={surface === "web-mobile"} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}
        connected busy={false} conversations={[]} onNewChat={noop} onSwitchConversation={openChat} onSubmit={noop}/>,
);
