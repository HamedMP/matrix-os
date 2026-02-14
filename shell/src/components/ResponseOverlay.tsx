"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ChatMessage } from "@/lib/chat";
import { MessageResponse } from "@/components/ai-elements/message";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ResponseOverlayProps {
  messages: ChatMessage[];
  busy: boolean;
  onDismiss: () => void;
}

const DEFAULT_WIDTH = 560;
const DEFAULT_CONTENT_HEIGHT = 200;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 80;

export function ResponseOverlay({
  messages,
  busy,
  onDismiss,
}: ResponseOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({
    width: DEFAULT_WIDTH,
    height: DEFAULT_CONTENT_HEIGHT,
  });

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

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.tool);

  const show = busy || lastAssistant;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastAssistant?.content]);

  const getDefaultPos = useCallback(
    () => ({
      x: (window.innerWidth - size.width) / 2,
      y: window.innerHeight - 180 - size.height,
    }),
    [size.width, size.height],
  );

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const current = pos ?? getDefaultPos();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: current.x,
        origY: current.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos, getDefaultPos],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPos({
      x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!pos) setPos(getDefaultPos());
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: size.width,
        origH: size.height,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos, size, getDefaultPos],
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    setSize({
      width: Math.max(
        MIN_WIDTH,
        resizeRef.current.origW + (e.clientX - resizeRef.current.startX),
      ),
      height: Math.max(
        MIN_HEIGHT,
        resizeRef.current.origH + (e.clientY - resizeRef.current.startY),
      ),
    });
  }, []);

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
  }, []);

  if (!show) return null;

  const currentPos = pos ?? getDefaultPos();

  return (
    <div
      className="response-overlay fixed z-40 animate-in fade-in slide-in-from-bottom-2 rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur-sm"
      style={{
        "--ro-x": `${currentPos.x}px`,
        "--ro-y": `${currentPos.y}px`,
        "--ro-w": `${size.width}px`,
      } as React.CSSProperties}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <div className="flex items-center gap-1.5">
          {busy && (
            <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />
          )}
          <span className="text-[11px] text-muted-foreground">
            {busy ? "Responding..." : "Response"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={onDismiss}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="overflow-y-auto px-3 py-2 text-sm"
        style={{ height: size.height }}
      >
        {lastAssistant ? (
          <MessageResponse>{lastAssistant.content}</MessageResponse>
        ) : busy ? (
          <span className="text-xs text-muted-foreground">Thinking...</span>
        ) : null}
      </div>

      <div
        className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      >
        <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/40">
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
    </div>
  );
}
