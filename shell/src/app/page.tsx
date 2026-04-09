"use client";

import { useState, useCallback, useEffect } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useChatState } from "@/hooks/useChatState";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCommandStore } from "@/stores/commands";
import { ChatProvider } from "@/stores/chat-context";

import { Desktop } from "@/components/Desktop";
import { CommandPalette } from "@/components/CommandPalette";
import { ThoughtCard } from "@/components/ThoughtCard";
import { ResponseOverlay } from "@/components/ResponseOverlay";
import { ApprovalDialog } from "@/components/ApprovalDialog";

export default function Home() {
  useTheme();
  useDesktopConfig();

  const chat = useChatState();
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useGlobalShortcuts(useCallback(() => setPaletteOpen(true), []));

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);

  useEffect(() => {
    register([
      {
        id: "action:new-chat",
        label: "New Chat",
        group: "Actions",
        shortcut: "Cmd+N",
        keywords: ["conversation", "session"],
        execute: () => chat.newChat(),
      },
    ]);
    return () => unregister(["action:new-chat"]);
  }, [register, unregister, chat.newChat]);

  const handleSubmit = useCallback(
    (text: string) => {
      setOverlayDismissed(false);
      chat.submitMessage(text);
    },
    [chat.submitMessage],
  );

  return (
    <ChatProvider value={chat}>
    <div className="flex h-screen w-screen overflow-hidden flex-col md:flex-row">
      <div className="flex flex-1 flex-col min-w-0 min-h-0">
        <div className="relative flex flex-col flex-1 min-h-0">
          <Desktop
            onOpenCommandPalette={() => setPaletteOpen(true)}
            chat={chat}
          />

          <div className="pointer-events-none absolute inset-0 flex flex-col p-2 md:p-4">
            <div className="flex justify-end">
              <ThoughtCard />
            </div>
          </div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ApprovalDialog />

      {!overlayDismissed && (
        <ResponseOverlay
          messages={chat.messages}
          busy={chat.busy}
          onDismiss={() => setOverlayDismissed(true)}
          onSubmit={handleSubmit}
        />
      )}

    </div>
    </ChatProvider>
  );
}
