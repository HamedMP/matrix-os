import type { CSSProperties, PointerEvent } from "react";
import type { ChatState } from "@/hooks/useChatState";
import type { AppWindow } from "@/hooks/useWindowManager";
import type { DockConfig } from "@/stores/desktop-config";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { cn } from "@/lib/utils";
import { Maximize2, Minus, X } from "@/lib/hugeicons";
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

function WindowControls({
  title,
  onClose,
  onMinimize,
  onMaximize,
}: {
  title: string;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
}) {
  const controlClass = "flex size-4 items-center justify-center rounded-[4.8px] border border-border bg-card text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label={`Close ${title}`} className={controlClass} onClick={onClose}>
        <X className="size-[11px]" strokeWidth={1.7} />
      </button>
      <button type="button" aria-label={`Minimize ${title}`} className={controlClass} onClick={onMinimize}>
        <Minus className="size-[11px]" strokeWidth={1.7} />
      </button>
      <button type="button" aria-label={`Maximize ${title}`} className={controlClass} onClick={onMaximize}>
        <Maximize2 className="size-[11px]" strokeWidth={1.7} />
      </button>
    </div>
  );
}

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
        ? "pointer-events-auto fixed inset-0 gap-0 rounded-none border-0 bg-background p-0 overflow-hidden"
        : cn(
            "app-window pointer-events-auto absolute gap-0 overflow-hidden rounded-none border border-border bg-card p-0 shadow-2xl md:rounded-xl",
          )
      }
      style={windowStyle}
      onMouseDown={() => !isFullscreen && onFocusWindow(win.id)}
    >
      <CardHeader
        className="flex h-[38px] flex-row items-center gap-0 space-y-0 border-b border-border bg-card/85 px-4 py-0 select-none backdrop-blur-xl md:cursor-grab md:active:cursor-grabbing"
        onPointerDown={(e) => onDragStart(win.id, e)}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onDoubleClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button,[role='button'],input,a")) return;
          onToggleFullscreen(win.id);
        }}
      >
        <WindowControls
          title={win.title}
          onClose={() => onCloseWindow(win.id)}
          onMinimize={() => onAnimateMinimize(win.id)}
          onMaximize={() => onToggleFullscreen(win.id)}
        />
        <CardTitle className="flex-1 truncate text-center text-xs font-medium text-foreground">
          {win.title}
        </CardTitle>
        <div className="w-[52px]" aria-hidden />
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
