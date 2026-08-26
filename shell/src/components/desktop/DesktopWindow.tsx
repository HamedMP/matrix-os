import type { CSSProperties, PointerEvent } from "react";
import type { ChatState } from "@/hooks/useChatState";
import type { AppWindow } from "@/hooks/useWindowManager";
import type { DockConfig } from "@/stores/desktop-config";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ActivityMonitorApp } from "@/components/system-activity/ActivityMonitorApp";
import { AppViewer } from "@/components/AppViewer";
import { ChatApp } from "@/components/ChatApp";
import { FileBrowser } from "@/components/file-browser/FileBrowser";
import { PreviewWindow } from "@/components/preview-window/PreviewWindow";
import { TerminalApp } from "@/components/terminal/TerminalApp";
import { WorkspaceApp } from "@/components/workspace/WorkspaceApp";
import { TrafficLights } from "./DesktopDockControls";
import { useThemeStyle } from "../window/useThemeStyle";
import { resolveTitleBarVariant, usesCaptionButtons, designTitleBarContainerStyle } from "../window/title-bar-variant";
import { DesignCaptionButtons } from "../window/DesignCaptionButtons";

interface DesktopWindowProps {
  win: AppWindow;
  chat?: ChatState;
  dockPosition: DockConfig["position"];
  fullscreenWindowId: string | null;
  interacting: boolean;
  minimizingIds: ReadonlySet<string>;
  onAnimateMinimize: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onDragEnd: () => void;
  onDragMove: (event: PointerEvent) => void;
  onDragStart: (id: string, event: PointerEvent) => void;
  onFocusWindow: (id: string) => void;
  onOpenWindow: (name: string, path: string) => void;
  onResizeEnd: () => void;
  onResizeMove: (event: PointerEvent) => void;
  onResizeStart: (id: string, event: PointerEvent) => void;
  onToggleFullscreen: (id: string) => void;
}

export function DesktopWindow({
  win,
  chat,
  dockPosition,
  fullscreenWindowId,
  interacting,
  minimizingIds,
  onAnimateMinimize,
  onCloseWindow,
  onDragEnd,
  onDragMove,
  onDragStart,
  onFocusWindow,
  onOpenWindow,
  onResizeEnd,
  onResizeMove,
  onResizeStart,
  onToggleFullscreen,
}: DesktopWindowProps) {
  const isFullscreen = win.id === fullscreenWindowId;
  const isMinimizing = minimizingIds.has(win.id);
  const isHidden = win.minimized && !isMinimizing && !isFullscreen;
  const terminalOwnsChrome = win.path.startsWith("__terminal__");
  const titleBarVariant = resolveTitleBarVariant(useThemeStyle());
  const captionButtons = usesCaptionButtons(titleBarVariant);

  let dockTargetX = 0;
  let dockTargetY = 0;
  if (isMinimizing) {
    const winCenterX = win.x + win.width / 2;
    const winCenterY = win.y + win.height / 2;
    if (dockPosition === "left") {
      dockTargetX = -winCenterX;
      dockTargetY = (window.innerHeight / 2) - winCenterY;
    } else if (dockPosition === "right") {
      dockTargetX = window.innerWidth - winCenterX;
      dockTargetY = (window.innerHeight / 2) - winCenterY;
    } else {
      dockTargetX = (window.innerWidth / 2) - winCenterX;
      dockTargetY = window.innerHeight - winCenterY;
    }
  }

  const windowStyle = isFullscreen ? {
    zIndex: SHELL_Z_INDEX.fullscreenWindow,
    transition: "all 300ms cubic-bezier(0.22, 1, 0.36, 1)",
  } : {
    "--win-x": `${win.x}px`,
    "--win-y": `${win.y}px`,
    "--win-w": `${win.width}px`,
    "--win-h": `${win.height}px`,
    zIndex: win.zIndex,
    transformOrigin: isMinimizing
      ? dockPosition === "left" ? "left center"
      : dockPosition === "right" ? "right center"
      : "center bottom"
      : undefined,
    transition: isMinimizing
      ? "transform 500ms cubic-bezier(0.5, 0, 0.7, 0.4), opacity 400ms cubic-bezier(0.4, 0, 1, 1), filter 500ms ease-out"
      : undefined,
    transform: isMinimizing
      ? `translate(${dockTargetX}px, ${dockTargetY}px) scale(0.03) rotate(${dockPosition === "bottom" ? "2deg" : "0deg"})`
      : undefined,
    opacity: isMinimizing ? 0 : undefined,
    filter: isMinimizing ? "blur(2px)" : undefined,
    pointerEvents: isMinimizing ? "none" : undefined,
    display: isHidden ? "none" : undefined,
  } as CSSProperties;

  return (
    <Card
      data-window-id={win.id}
      className={isFullscreen
        ? "fixed inset-0 gap-0 rounded-none p-0 overflow-hidden border-0 bg-background"
        : cn(
            "app-window absolute gap-0 rounded-none md:rounded-lg p-0 overflow-hidden shadow-2xl",
            terminalOwnsChrome && "border-0",
          )
      }
      style={windowStyle}
      onMouseDown={() => !isFullscreen && onFocusWindow(win.id)}
    >
      <CardHeader
        className={cn(
          "flex flex-row items-center gap-0 px-3 py-2 md:cursor-grab md:active:cursor-grabbing select-none space-y-0",
          terminalOwnsChrome ? "border-b-0" : "border-b border-border",
        )}
        style={terminalOwnsChrome && !captionButtons
          ? { background: "var(--terminal-drawer-bg)", color: "var(--terminal-drawer-fg)" }
          : designTitleBarContainerStyle(titleBarVariant)}
        onPointerDown={(e) => onDragStart(win.id, e)}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onDoubleClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button,[role='button'],input,a")) return;
          onToggleFullscreen(win.id);
        }}
      >
        {captionButtons ? (
          <>
            <CardTitle
              className={cn(
                "text-xs truncate flex-1",
                titleBarVariant === "winxp" ? "font-bold text-white" : "font-medium text-foreground/70",
              )}
              style={titleBarVariant === "winxp"
                ? { fontFamily: 'Tahoma, "Segoe UI", sans-serif', textShadow: "0 1px 2px rgba(0, 0, 0, 0.5)" }
                : undefined}
            >
              {win.title}
            </CardTitle>
            <DesignCaptionButtons
              variant={titleBarVariant}
              onClose={() => onCloseWindow(win.id)}
              onMinimize={() => onAnimateMinimize(win.id)}
              onMaximize={() => onToggleFullscreen(win.id)}
            />
          </>
        ) : (
          <>
            <TrafficLights
              onClose={() => onCloseWindow(win.id)}
              onMinimize={() => onAnimateMinimize(win.id)}
              onFullscreen={() => onToggleFullscreen(win.id)}
            />
            <CardTitle className="text-xs font-medium truncate flex-1 text-center">
              {win.title}
            </CardTitle>
            <div className="w-[78px]" aria-hidden />
          </>
        )}
      </CardHeader>

      <CardContent className="relative flex-1 p-0 min-h-0">
        {win.path.startsWith("__terminal__") ? (
          <TerminalApp
            launchTargetId={win.id}
            embeddedChrome
            windowControls={{
              close: () => onCloseWindow(win.id),
              minimize: () => onAnimateMinimize(win.id),
              toggleFullscreen: () => onToggleFullscreen(win.id),
              dragHandleProps: {
                onPointerDown: (event) => onDragStart(win.id, event),
                onPointerMove: onDragMove,
                onPointerUp: onDragEnd,
                onPointerCancel: onDragEnd,
                onDoubleClick: () => onToggleFullscreen(win.id),
              },
            }}
          />
        ) : win.path === "__workspace__" ? (
          <WorkspaceApp />
        ) : win.path === "__file-browser__" ? (
          <FileBrowser windowId={win.id} />
        ) : win.path === "__preview-window__" ? (
          <PreviewWindow />
        ) : win.path === "__chat__" ? (
          <div className="h-full overflow-hidden">
            {chat && (
              <ChatApp
                messages={chat.messages}
                sessionId={chat.sessionId}
                busy={chat.busy}
                connected={chat.connected}
                conversations={chat.conversations}
                onNewChat={chat.newChat}
                onSwitchConversation={chat.switchConversation}
                onSubmit={chat.submitMessage}
              />
            )}
          </div>
        ) : win.path === "__activity-monitor__" ? (
          <ActivityMonitorApp />
        ) : (
          <AppViewer path={win.path} onOpenApp={onOpenWindow} />
        )}
        {interacting && (
          <div className="absolute inset-0 z-10" />
        )}
      </CardContent>

      {!isFullscreen && (
        <div
          className="hidden md:block absolute bottom-0 right-0 size-4 cursor-se-resize touch-none z-20"
          onPointerDown={(e) => onResizeStart(win.id, e)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
        >
          <svg
            viewBox="0 0 16 16"
            className="size-4 text-muted-foreground/40"
          >
            <path
              d="M14 2v12H2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
            <path
              d="M14 7v7H7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </div>
      )}
    </Card>
  );
}
