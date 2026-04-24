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

// Chat lives as a popover triggered from the dock (see ChatPopover wired
// into Desktop.tsx). The old floating ResponseOverlay was removed because
// it competed with apps for screen space and felt heavier than chat
// actually needs to be.
export default function Home() {
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
    <div className="flex h-screen w-screen overflow-hidden flex-col md:flex-row">
      <div className="flex flex-1 flex-col min-w-0 min-h-0">
        <div className="relative flex flex-col flex-1 min-h-0">
          <Desktop
            onOpenCommandPalette={() => setPaletteOpen(true)}
            chat={chat}
          />
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ApprovalDialog />
      {/* Build progress card lives inside VocalPanel today (gateway-side
          delegation tracking). Chat does not yet have an equivalent
          "is the agent building an app right now" signal -- adding it
          would require gateway-side detection of app-creating tool runs.
          Until then, the chat surface stays self-contained (header pill +
          inline tool rows) without a top-center duplicate. */}
    </div>
    </ChatProvider>
  );
}
