"use client";

import { useState, useCallback, useEffect } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useChatState } from "@/hooks/useChatState";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCommandStore } from "@/stores/commands";
import { ChatProvider } from "@/stores/chat-context";
import { useWindowManager } from "@/hooks/useWindowManager";

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
  const wmOpenWindow = useWindowManager((s) => s.openWindow);

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const intent = params.get("matrixDesktopApp");
    if (!intent) return;

    const requestedPath = params.get("path") ?? "";
    const safeAppPath = requestedPath.match(/^apps\/[a-z0-9][a-z0-9-]{0,63}\/index\.html$/)?.[0];
    const intentWindow =
      intent === "terminal"
        ? { title: "Terminal", path: "__terminal__" }
        : intent === "workspace"
          ? { title: "Workspace", path: "__workspace__" }
          : intent === "file-browser"
            ? { title: "Files", path: "__file-browser__" }
            : intent === "chat"
              ? { title: "Chat", path: "__chat__" }
              : safeAppPath
                ? { title: safeAppPath.split("/")[1] ?? "App", path: safeAppPath }
                : null;

    if (!intentWindow) return;
    window.history.replaceState(null, "", window.location.pathname);
    wmOpenWindow(intentWindow.title, intentWindow.path, 20);
  }, [wmOpenWindow]);

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
