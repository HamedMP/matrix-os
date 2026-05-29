"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useChatState } from "@/hooks/useChatState";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCommandStore } from "@/stores/commands";
import { ChatProvider } from "@/stores/chat-context";
import { capturePostHogEvent } from "@/lib/posthog-client";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";

import { Desktop } from "@/components/Desktop";
import { MobileShell } from "@/components/mobile/MobileShell";
import { CommandPalette } from "@/components/CommandPalette";
import { ApprovalDialog } from "@/components/ApprovalDialog";
import { useMobileViewport } from "@/hooks/useMobileViewport";

const LAUNCHABLE_BUILT_IN_PATHS = new Set([
  "__terminal__",
  "__chat__",
  "__file-browser__",
  "__workspace__",
  "__preview-window__",
]);

function readLaunchPathFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const launch = new URLSearchParams(window.location.search).get("launch");
  return launch && LAUNCHABLE_BUILT_IN_PATHS.has(launch) ? launch : null;
}

export function ShellHome() {
  useTheme();
  useDesktopConfig();

  const chat = useChatState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [launchAppPath, setLaunchAppPath] = useState<string | null>(null);
  const isMobile = useMobileViewport();
  const shellLoadedCaptured = useRef(false);

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
    setLaunchAppPath(readLaunchPathFromLocation());
  }, []);

  useEffect(() => {
    if (shellLoadedCaptured.current) return;
    shellLoadedCaptured.current = true;
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_LOADED, {
      surface: isMobile ? "mobile" : "desktop",
    });
  }, [isMobile]);

  return (
    <ChatProvider value={chat}>
      <div className="flex h-screen w-screen flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            {isMobile ? (
              <MobileShell
                launchAppPath={launchAppPath}
                onOpenCommandPalette={() => setPaletteOpen(true)}
              />
            ) : (
              <Desktop
                launchAppPath={launchAppPath}
                onOpenCommandPalette={() => setPaletteOpen(true)}
                chat={chat}
              />
            )}
          </div>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ApprovalDialog />
      </div>
    </ChatProvider>
  );
}
