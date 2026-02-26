"use client";

import { useState, useCallback, useRef } from "react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";

interface SelectionRectProps {
  onSelect: (windowIds: string[]) => void;
}

export function SelectionRect({ onSelect }: SelectionRectProps) {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);
  const zoom = useCanvasTransform((s) => s.zoom);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only start selection on left-click directly on the background
      if (e.button !== 0 || e.target !== e.currentTarget) return;
      const canvas = screenToCanvas(e.clientX, e.clientY);
      startRef.current = canvas;
      setRect({ x: canvas.x, y: canvas.y, w: 0, h: 0 });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [screenToCanvas],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startRef.current) return;
      const canvas = screenToCanvas(e.clientX, e.clientY);
      const x = Math.min(startRef.current.x, canvas.x);
      const y = Math.min(startRef.current.y, canvas.y);
      const w = Math.abs(canvas.x - startRef.current.x);
      const h = Math.abs(canvas.y - startRef.current.y);
      setRect({ x, y, w, h });
    },
    [screenToCanvas],
  );

  const onPointerUp = useCallback(() => {
    if (!rect || !startRef.current) {
      startRef.current = null;
      setRect(null);
      return;
    }

    const windows = useWindowManager.getState().windows;
    const selected = windows.filter((win) => {
      const winRight = win.x + win.width;
      const winBottom = win.y + win.height;
      const rectRight = rect.x + rect.w;
      const rectBottom = rect.y + rect.h;
      return (
        win.x < rectRight &&
        winRight > rect.x &&
        win.y < rectBottom &&
        winBottom > rect.y
      );
    });

    if (selected.length > 0) {
      onSelect(selected.map((w) => w.id));
    }

    startRef.current = null;
    setRect(null);
  }, [rect, onSelect]);

  return (
    <>
      {rect && rect.w > 5 && rect.h > 5 && (
        <div
          className="absolute border-2 border-primary/40 bg-primary/10 rounded-sm pointer-events-none"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            zIndex: 9999,
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ zIndex: -1 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </>
  );
}
