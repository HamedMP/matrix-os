"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useChatState } from "@/hooks/useChatState";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCommandStore } from "@/stores/commands";
import { useDesktopMode } from "@/stores/desktop-mode";
import { Desktop } from "@/components/Desktop";
import { AppViewer } from "@/components/AppViewer";
import { ChatPanel } from "@/components/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { InputBar } from "@/components/InputBar";
import { SuggestionChips } from "@/components/SuggestionChips";
import { ThoughtCard } from "@/components/ThoughtCard";
import { ResponseOverlay } from "@/components/ResponseOverlay";
import { ApprovalDialog } from "@/components/ApprovalDialog";
import { AppStore } from "@/components/app-store/AppStore";
import { BottomPanel } from "@/components/BottomPanel";
import { FileBrowser } from "@/components/file-browser/FileBrowser";
import { Settings } from "@/components/Settings";
import { TerminalApp } from "@/components/terminal/TerminalApp";
import { VoiceMode } from "@/components/VoiceMode";
import { Button } from "@/components/ui/button";
import { MessageSquareIcon } from "lucide-react";

export default function Home() {
  const searchParams = useSearchParams();
  const embeddedAppSlug =
    searchParams.get("desktop") === "1" ? searchParams.get("app") : null;

  if (embeddedAppSlug) {
    return <EmbeddedDesktopApp slug={embeddedAppSlug} />;
  }

  return <HomeShell />;
}

function EmbeddedDesktopApp({ slug }: { slug: string }) {
  useTheme();

  if (slug === "terminal") {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background">
        <TerminalApp embedded />
      </div>
    );
  }

  if (slug === "files") {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background">
        <FileBrowser windowId="embedded-files" />
      </div>
    );
  }

  if (slug === "chat") {
    return <EmbeddedChatApp />;
  }

  if (slug === "settings") {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background">
        <Settings open onOpenChange={() => {}} />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-background">
      <AppViewer path={`apps/${slug}/index.html`} />
    </div>
  );
}

function EmbeddedChatApp() {
  useTheme();
  const chat = useChatState();

  return (
    <div className="h-screen w-screen overflow-hidden bg-background">
      <ChatPanel
        messages={chat.messages}
        sessionId={chat.sessionId}
        busy={chat.busy}
        connected={chat.connected}
        conversations={chat.conversations}
        onNewChat={chat.newChat}
        onSwitchConversation={chat.switchConversation}
        onClose={() => {}}
        onSubmit={chat.submitMessage}
        inputBar={
          <InputBar
            sessionId={chat.sessionId}
            busy={chat.busy}
            queueLength={chat.queue.length}
            onSubmit={chat.submitMessage}
            embedded
          />
        }
      />
    </div>
  );
}

function HomeShell() {
  useTheme();
  useDesktopConfig();

  const chat = useChatState();
  const modeConfig = useDesktopMode((s) => s.getModeConfig(s.mode));
  const isCenterChat = modeConfig.chatPosition === "center";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [voiceModeActive, setVoiceModeActive] = useState(false);

  useGlobalShortcuts(useCallback(() => setPaletteOpen(true), []));

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);

  useEffect(() => {
    register([
      {
        id: "action:toggle-sidebar",
        label: "Toggle Chat Sidebar",
        group: "Actions",
        shortcut: "Cmd+B",
        keywords: ["chat", "panel", "messages"],
        execute: () => setSidebarOpen((prev) => !prev),
      },
      {
        id: "action:new-chat",
        label: "New Chat",
        group: "Actions",
        shortcut: "Cmd+N",
        keywords: ["conversation", "session"],
        execute: () => chat.newChat(),
      },
      {
        id: "action:app-store",
        label: "App Store",
        group: "Actions",
        keywords: ["store", "install", "browse", "apps", "marketplace"],
        execute: () => setStoreOpen((prev) => !prev),
      },
    ]);
    return () => unregister(["action:toggle-sidebar", "action:new-chat", "action:app-store"]);
  }, [register, unregister, chat.newChat]);

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

  const showEmbeddedInput = sidebarOpen || isCenterChat;

  const voiceModeToggle = useCallback(() => setVoiceModeActive((v) => !v), []);

  const embeddedInputBar = (
    <InputBar
      sessionId={chat.sessionId}
      busy={chat.busy}
      queueLength={chat.queue.length}
      onSubmit={handleSubmit}
      onVoiceModeToggle={voiceModeToggle}
      voiceModeActive={voiceModeActive}
      embedded
    />
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden flex-col md:flex-row">
      <div className="flex flex-1 flex-col min-w-0 min-h-0">
        <div className="relative flex flex-col flex-1 min-h-0">
          <Desktop storeOpen={storeOpen} onToggleStore={() => setStoreOpen((prev) => !prev)} onCloseStore={() => setStoreOpen(false)} />

          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2 md:p-4">
            <div className="flex justify-end">
              <ThoughtCard />
            </div>

            {!showEmbeddedInput && (
              <div className="pointer-events-auto flex justify-center pb-2 md:pb-2">
                <InputBar
                  sessionId={chat.sessionId}
                  busy={chat.busy}
                  queueLength={chat.queue.length}
                  onSubmit={handleSubmit}
                  onVoiceModeToggle={voiceModeToggle}
                  voiceModeActive={voiceModeActive}
                  chips={
                    <SuggestionChips
                      context={chipContext}
                      onSelect={handleSubmit}
                    />
                  }
                />
              </div>
            )}
          </div>
        </div>

        {modeConfig.showBottomPanel && (
          <div className="hidden md:block">
            <BottomPanel />
          </div>
        )}
      </div>

      {!isCenterChat && !sidebarOpen && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed right-3 top-3 z-50 size-8 rounded-lg border border-border bg-card/80 backdrop-blur-sm"
          onClick={() => setSidebarOpen(true)}
        >
          <MessageSquareIcon className="size-4" />
        </Button>
      )}

      {isCenterChat && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
          <div className="pointer-events-auto w-full max-w-2xl mx-4 max-h-[70vh] overflow-hidden rounded-2xl border border-border bg-card/95 backdrop-blur-xl shadow-2xl">
            <ChatPanel
              messages={chat.messages}
              sessionId={chat.sessionId}
              busy={chat.busy}
              connected={chat.connected}
              conversations={chat.conversations}
              onNewChat={chat.newChat}
              onSwitchConversation={chat.switchConversation}
              onClose={() => {}}
              onSubmit={handleSubmit}
              inputBar={embeddedInputBar}
            />
          </div>
        </div>
      )}

      {!isCenterChat && sidebarOpen && (
        <ChatPanel
          messages={chat.messages}
          sessionId={chat.sessionId}
          busy={chat.busy}
          connected={chat.connected}
          conversations={chat.conversations}
          onNewChat={chat.newChat}
          onSwitchConversation={chat.switchConversation}
          onClose={() => setSidebarOpen(false)}
          onSubmit={handleSubmit}
          inputBar={embeddedInputBar}
        />
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ApprovalDialog />
      <AppStore open={storeOpen} onOpenChange={setStoreOpen} />

      {!sidebarOpen && !overlayDismissed && (
        <ResponseOverlay
          messages={chat.messages}
          busy={chat.busy}
          onDismiss={() => setOverlayDismissed(true)}
          onSubmit={handleSubmit}
        />
      )}

      {voiceModeActive && (
        <VoiceMode
          onClose={() => setVoiceModeActive(false)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}
