"use client";

import { useState, useCallback, useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useChatState } from "@/hooks/useChatState";
import { Desktop } from "@/components/Desktop";
import { ChatPanel } from "@/components/ChatPanel";
import { InputBar } from "@/components/InputBar";
import { SuggestionChips } from "@/components/SuggestionChips";
import { ThoughtCard } from "@/components/ThoughtCard";
import { ResponseOverlay } from "@/components/ResponseOverlay";
import { BottomPanel } from "@/components/BottomPanel";
import { Button } from "@/components/ui/button";
import { MessageSquareIcon } from "lucide-react";

export default function Home() {
  useTheme();

  const chat = useChatState();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const chipContext = useMemo(() => {
    const hasError = chat.messages.some(
      (m) => m.role === "system" && !m.tool,
    );
    if (hasError) return "error" as const;

    const hasMessages = chat.messages.some((m) => m.role === "user");
    if (hasMessages) return "app" as const;

    return "empty" as const;
  }, [chat.messages]);

  const handleSubmit = useCallback(
    (text: string) => {
      setOverlayDismissed(false);
      chat.submitMessage(text);
    },
    [chat.submitMessage],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex flex-1 flex-col min-w-0">
        <div className="relative flex flex-col flex-1 min-h-0">
          <Desktop />

          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
            <div className="flex justify-end">
              <ThoughtCard />
            </div>

            <div className="pointer-events-auto flex justify-center pb-2">
              <InputBar
                sessionId={chat.sessionId}
                busy={chat.busy}
                onSubmit={handleSubmit}
                chips={
                  <SuggestionChips
                    context={chipContext}
                    onSelect={handleSubmit}
                  />
                }
              />
            </div>
          </div>
        </div>

        <BottomPanel />
      </div>

      {sidebarOpen ? (
        <ChatPanel
          messages={chat.messages}
          sessionId={chat.sessionId}
          busy={chat.busy}
          connected={chat.connected}
          conversations={chat.conversations}
          onNewChat={chat.newChat}
          onSwitchConversation={chat.switchConversation}
          onClose={() => setSidebarOpen(false)}
        />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="fixed right-3 top-3 z-50 size-8 rounded-lg border border-border bg-card/80 backdrop-blur-sm"
          onClick={() => setSidebarOpen(true)}
        >
          <MessageSquareIcon className="size-4" />
        </Button>
      )}

      {!sidebarOpen && !overlayDismissed && (
        <ResponseOverlay
          messages={chat.messages}
          busy={chat.busy}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
    </div>
  );
}
