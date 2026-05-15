"use client";

import { ChatApp } from "@/components/ChatApp";
import { DesktopStandaloneFrame } from "@/components/desktop/DesktopStandaloneFrame";
import { useChatState } from "@/hooks/useChatState";
import { ChatProvider } from "@/stores/chat-context";

export default function DesktopChatPage() {
  const chat = useChatState();

  return (
    <ChatProvider value={chat}>
      <DesktopStandaloneFrame>
        <ChatApp
          messages={chat.messages}
          sessionId={chat.sessionId}
          busy={chat.busy}
          connected={chat.connected}
          conversations={chat.conversations}
          onNewChat={chat.newChat}
          onSwitchConversation={chat.switchConversation}
          onSubmit={(text) => chat.submitMessage(text)}
        />
      </DesktopStandaloneFrame>
    </ChatProvider>
  );
}
