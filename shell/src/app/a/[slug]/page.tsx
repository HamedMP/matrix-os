"use client"

import { use, useState, useCallback, useEffect, useMemo } from "react"
import { useTheme } from "@/hooks/useTheme"
import { useChatState } from "@/hooks/useChatState"
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts"
import { useSocket } from "@/hooks/useSocket"
import { AppViewer } from "@/components/AppViewer"
import { TerminalApp } from "@/components/terminal/TerminalApp"
import { FileBrowser } from "@/components/file-browser/FileBrowser"
import { ChatPanel } from "@/components/ChatPanel"
import { CommandPalette } from "@/components/CommandPalette"
import { InputBar } from "@/components/InputBar"
import { ApprovalDialog } from "@/components/ApprovalDialog"
import { AppStore } from "@/components/app-store/AppStore"
import { UserButton } from "@/components/UserButton"
import { getGatewayUrl } from "@/lib/gateway"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  MessageSquareIcon,
  StoreIcon,
  TerminalIcon,
  SettingsIcon,
  GridIcon,
} from "lucide-react"

const GATEWAY_URL = getGatewayUrl()

interface AppEntry {
  slug: string
  name: string
  icon: string
  builtIn: boolean
  path?: string
}

function AppContent({ slug }: { slug: string }) {
  if (slug === "terminal") {
    return <TerminalApp embedded />
  }
  if (slug === "files") {
    return <FileBrowser windowId="embedded-files" />
  }
  // For all other apps, load via AppViewer using their manifest path
  return <AppViewer path={`apps/${slug}/index.html`} />
}

export default function AppPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = use(params)
  useTheme()

  const chat = useChatState()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  const [apps, setApps] = useState<AppEntry[]>([])

  useGlobalShortcuts(useCallback(() => setPaletteOpen(true), []))

  // Fetch app list for the launcher
  useEffect(() => {
    fetch(`${GATEWAY_URL}/api/apps`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setApps)
      .catch(() => {})
  }, [])

  const currentApp = apps.find((a) => a.slug === slug)
  const isDesktop = typeof window !== "undefined" && (
    new URLSearchParams(window.location.search).get("desktop") === "1" ||
    !!(window as unknown as { matrixDesktop?: unknown }).matrixDesktop
  )

  // In desktop mode, opening an app should create a new Electron tab
  const openApp = useCallback(
    (appSlug: string) => {
      if (isDesktop && (window as unknown as { electronAPI?: Record<string, (s: string) => void> }).electronAPI) {
        (window as unknown as { electronAPI: Record<string, (s: string) => void> }).electronAPI["tab:create"](appSlug)
      } else {
        window.location.href = `/a/${appSlug}`
      }
    },
    [isDesktop],
  )

  const embeddedInputBar = (
    <InputBar
      sessionId={chat.sessionId}
      busy={chat.busy}
      queueLength={chat.queue.length}
      onSubmit={chat.submitMessage}
      embedded
    />
  )

  return (
    <TooltipProvider delayDuration={300}>
      {isDesktop ? (
        <div className="h-screen w-screen overflow-hidden bg-background">
          <AppContent slug={slug} />
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
          <ApprovalDialog />
        </div>
      ) : (
      <div className="flex h-screen w-screen overflow-hidden">
        {/* Minimal sidebar: user, launcher, chat, settings */}
        <aside className="hidden md:flex flex-col items-center gap-2 py-3 px-1.5 bg-card/40 backdrop-blur-sm border-r border-border/40 z-50"
          style={{ width: 48 }}
        >
          {/* App launcher */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setStoreOpen((p) => !p)}
                className="flex items-center justify-center size-8 rounded-lg border border-border/60 bg-card hover:shadow-md hover:scale-105 active:scale-95 transition-all"
              >
                <GridIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Apps</TooltipContent>
          </Tooltip>

          {/* Quick app icons */}
          {apps.slice(0, 6).map((app) => (
            <Tooltip key={app.slug}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => openApp(app.slug)}
                  className={`flex items-center justify-center size-8 rounded-lg border transition-all hover:shadow-md hover:scale-105 active:scale-95 ${
                    app.slug === slug
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border/60 bg-card"
                  }`}
                >
                  {app.icon ? (
                    <img
                      src={`${GATEWAY_URL}${app.icon}`}
                      alt={app.name}
                      className="size-5 rounded"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none"
                      }}
                    />
                  ) : (
                    <TerminalIcon className="size-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {app.name}
              </TooltipContent>
            </Tooltip>
          ))}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Chat toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSidebarOpen((p) => !p)}
                className={`flex items-center justify-center size-8 rounded-lg border transition-all hover:shadow-md hover:scale-105 active:scale-95 ${
                  sidebarOpen
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border/60 bg-card"
                }`}
              >
                <MessageSquareIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Chat</TooltipContent>
          </Tooltip>

          {/* Settings */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => openApp("settings")}
                className="flex items-center justify-center size-8 rounded-lg border border-border/60 bg-card hover:shadow-md hover:scale-105 active:scale-95 transition-all"
              >
                <SettingsIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Settings</TooltipContent>
          </Tooltip>

          {/* User */}
          <UserButton />
        </aside>

        {/* App content */}
        <main className="flex-1 min-w-0 min-h-0 relative">
          <AppContent slug={slug} />
        </main>

        {/* Chat sidebar */}
        {sidebarOpen && (
          <ChatPanel
            messages={chat.messages}
            sessionId={chat.sessionId}
            busy={chat.busy}
            connected={chat.connected}
            conversations={chat.conversations}
            onNewChat={chat.newChat}
            onSwitchConversation={chat.switchConversation}
            onClose={() => setSidebarOpen(false)}
            onSubmit={chat.submitMessage}
            inputBar={embeddedInputBar}
          />
        )}

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ApprovalDialog />
        <AppStore open={storeOpen} onOpenChange={setStoreOpen} />
      </div>
      )}
    </TooltipProvider>
  )
}
