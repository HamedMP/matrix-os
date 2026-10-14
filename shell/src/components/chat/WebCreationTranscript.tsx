"use client";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { groupMessages } from "@/lib/chat";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { ToolCallGroup } from "@/components/ToolCallGroup";
import { CanonicalApprovalMessage } from "./CanonicalApprovalMessage";
import { AssistantBubble } from "./AssistantBubble";

/** Only gateway-returned messages are projected; the introduction is outside Chat. */
export function WebCreationTranscript({ detail }: { detail: CanonicalChatDetailResponse }) {
  return <Conversation>
    <ConversationContent className="mx-auto w-full max-w-[720px] gap-5 px-4 py-5">
      {groupMessages(projectCanonicalTranscript(detail)).map(group => {
        if (group.type === "tool_group") return <ToolCallGroup key={group.messages[0].id} tools={group.messages}/>;
        const message = group.message;
        return message.role === "user" ? <Message key={message.id} from="user">
          <MessageContent><span className="whitespace-pre-wrap">{message.content}</span></MessageContent>
        </Message> : message.role === "system" ? <CanonicalApprovalMessage key={message.id} message={message} submitting={false}/>
          : <AssistantBubble key={message.id} content={message.content}/>;
      })}
    </ConversationContent>
    <ConversationScrollButton/>
  </Conversation>;
}
