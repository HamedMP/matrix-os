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
import { ApprovalDialog } from "@/components/ApprovalDialog";

export function ShellHome() {
  useTheme();
  useDesktopConfig();

  const chat = useChatState();
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

  return (
    <ChatProvider value={chat}>
      <div className="flex h-screen w-screen flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Desktop
              onOpenCommandPalette={() => setPaletteOpen(true)}
              chat={chat}
            />
          </div>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ApprovalDialog />
      </div>
    </ChatProvider>
  );
}
