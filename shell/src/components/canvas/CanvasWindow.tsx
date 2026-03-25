"use client";

import { useCallback, useRef, useState } from "react";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { AppViewer } from "../AppViewer";
import { TerminalApp } from "../terminal/TerminalApp";
import { FileBrowser } from "../file-browser/FileBrowser";
import { PreviewWindow } from "../preview-window/PreviewWindow";
import { X, Maximize2 } from "lucide-react";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

interface CanvasWindowProps {
  win: AppWindow;
}

export function CanvasWindow({ win }: CanvasWindowProps) {
  const zoom = useCanvasTransform((s) => s.zoom);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const focusWindow = useWindowManager((s) => s.focusWindow);
  const moveWindow = useWindowManager((s) => s.moveWindow);
  const resizeWindow = useWindowManager((s) => s.resizeWindow);
  const iconUrl = useWindowManager((s) => s.apps.find((a) => a.path === win.path)?.iconUrl);

  const fitWindow = useCallback(() => {
    fitAll(
      [{ x: win.x, y: win.y, width: win.width, height: win.height }],
      window.innerWidth,
      window.innerHeight,
    );
  }, [fitAll, win.x, win.y, win.width, win.height]);

  const [interacting, setInteracting] = useState(false);
  const isInteractive = zoom >= INTERACTION_THRESHOLD;
  const inverseScale = 1 / zoom;

  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: win.x,
        origY: win.y,
      };
      setInteracting(true);
      focusWindow(win.id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [win.x, win.y, win.id, focusWindow],
  );

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const { startX, startY, origX, origY } = dragRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      moveWindow(win.id, origX + dx, origY + dy);
    },
    [win.id, zoom, moveWindow],
  );

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setInteracting(false);
  }, []);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: win.width,
        origH: win.height,
      };
      setInteracting(true);
      focusWindow(win.id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [win.width, win.height, win.id, focusWindow],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, origW, origH } = resizeRef.current;
      const dw = (e.clientX - startX) / zoom;
      const dh = (e.clientY - startY) / zoom;
      resizeWindow(
        win.id,
        Math.max(MIN_WIDTH, origW + dw),
        Math.max(MIN_HEIGHT, origH + dh),
      );
    },
    [win.id, zoom, resizeWindow],
  );

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    setInteracting(false);
  }, []);

  // Zoomed-out preview: show icon + title card with close/maximize buttons
  if (!isInteractive) {
    return (
      <div
        className="absolute"
        style={{
          left: win.x,
          top: win.y,
          zIndex: win.zIndex,
          pointerEvents: "auto",
        }}
      >
        {/* Inverse-scaled controls above the window */}
        <div
          className="absolute"
          style={{
            bottom: "100%",
            left: 0,
            right: 0,
            transform: `scale(${inverseScale})`,
            transformOrigin: "left bottom",
            paddingBottom: 4,
          }}
        >
          <div
            className="flex items-center gap-1 cursor-grab active:cursor-grabbing select-none group/label whitespace-nowrap"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
          >
            <span className="text-sm font-medium text-primary truncate max-w-[300px] flex-1">
              {win.title}
            </span>
            <button
              className="opacity-0 group-hover/label:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                fitWindow();
              }}
              aria-label="Zoom to fit"
            >
              <Maximize2 className="size-3.5 text-muted-foreground" />
            </button>
            <button
              className="opacity-0 group-hover/label:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                closeWindow(win.id);
              }}
              aria-label="Close"
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
        {/* Frame body with icon - no border, just subtle shadow */}
        <div
          className="rounded-lg bg-card overflow-hidden shadow-md flex items-center justify-center"
          style={{ width: win.width, height: win.height }}
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt={win.title}
              className="size-16 object-contain opacity-50"
              draggable={false}
            />
          ) : (
            <span className="text-3xl font-semibold text-muted-foreground/20">
              {win.title.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Zoomed-in interactive: frameless content with subtle shadow
  return (
    <div
      className="absolute"
      style={{
        left: win.x,
        top: win.y,
        zIndex: win.zIndex,
      }}
      onMouseDown={() => focusWindow(win.id)}
    >
      {/* Inverse-scaled controls above the window */}
      <div
        className="absolute"
        style={{
          bottom: "100%",
          left: 0,
          right: 0,
          transform: `scale(${inverseScale})`,
          transformOrigin: "left bottom",
          paddingBottom: 4,
        }}
      >
        <div
          className="flex items-center gap-1 cursor-grab active:cursor-grabbing select-none group/label whitespace-nowrap"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
        >
          <span className="text-[11px] font-medium text-primary truncate max-w-[200px] flex-1">
            {win.title}
          </span>
          <button
            className="opacity-0 group-hover/label:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              fitWindow();
            }}
            aria-label="Zoom to fit"
          >
            <Maximize2 className="size-3 text-muted-foreground" />
          </button>
          <button
            className="opacity-0 group-hover/label:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              closeWindow(win.id);
            }}
            aria-label="Close"
          >
            <X className="size-3 text-muted-foreground" />
          </button>
        </div>
      </div>
      {/* Frame body - no border, clean shadow */}
      <div
        className="rounded-lg bg-card overflow-hidden shadow-lg"
        style={{ width: win.width, height: win.height }}
      >
        {win.path.startsWith("__terminal__") ? (
          <TerminalApp />
        ) : win.path === "__file-browser__" ? (
          <FileBrowser windowId={win.id} />
        ) : win.path === "__preview-window__" ? (
          <PreviewWindow />
        ) : (
          <AppViewer path={win.path} />
        )}
        {interacting && <div className="absolute inset-0 z-10" />}
      </div>
      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 size-3 cursor-se-resize touch-none z-20"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      >
        <svg viewBox="0 0 12 12" className="size-3 text-muted-foreground/30">
          <path d="M11 1v10H1" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M11 5v6H5" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
