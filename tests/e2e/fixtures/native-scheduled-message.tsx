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
const noop = () => undefined;
createRoot(document.getElementById("root")!).render(
  surface === "electron"
    ? <ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: noop }}/>
    : <ChatApp mobile={surface === "web-mobile"} messages={projectCanonicalTranscript(detail)} sessionId={detail.record.chat.id}
        connected busy={false} conversations={[]} onNewChat={noop} onSwitchConversation={noop} onSubmit={noop}/>,
);
