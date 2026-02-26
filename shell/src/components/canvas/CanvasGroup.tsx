"use client";

import { useCallback, useRef } from "react";
import { useCanvasGroups, type CanvasGroup } from "@/stores/canvas-groups";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";

interface CanvasGroupProps {
  group: CanvasGroup;
}

export function CanvasGroupRect({ group }: CanvasGroupProps) {
  const bounds = useCanvasGroups((s) => s.getGroupBounds)(group.id);
  const deleteGroup = useCanvasGroups((s) => s.deleteGroup);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const moveWindow = useWindowManager((s) => s.moveWindow);
  const windows = useWindowManager((s) => s.windows);

  const dragRef = useRef<{ startX: number; startY: number; memberPositions: Map<string, { x: number; y: number }> } | null>(null);
  const zoom = useCanvasTransform((s) => s.zoom);

  const onHeaderDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const memberPositions = new Map<string, { x: number; y: number }>();
      for (const winId of group.windowIds) {
        const win = windows.find((w) => w.id === winId);
        if (win) memberPositions.set(winId, { x: win.x, y: win.y });
      }
      dragRef.current = { startX: e.clientX, startY: e.clientY, memberPositions };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [group.windowIds, windows],
  );

  const onHeaderDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const dx = (e.clientX - dragRef.current.startX) / zoom;
      const dy = (e.clientY - dragRef.current.startY) / zoom;
      for (const [winId, orig] of dragRef.current.memberPositions) {
        moveWindow(winId, orig.x + dx, orig.y + dy);
      }
    },
    [zoom, moveWindow],
  );

  const onHeaderDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onDoubleClick = useCallback(() => {
    const memberWindows = windows.filter((w) => group.windowIds.includes(w.id));
    if (memberWindows.length === 0) return;
    fitAll(
      memberWindows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      window.innerWidth,
      window.innerHeight,
    );
  }, [windows, group.windowIds, fitAll]);

  if (!bounds) return null;

  return (
    <div
      className="absolute rounded-xl border-2 border-dashed"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        borderColor: group.color,
        backgroundColor: `${group.color}08`,
        zIndex: 0,
        pointerEvents: "auto",
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing select-none"
        style={{
          backgroundColor: `${group.color}20`,
          borderRadius: "10px 10px 0 0",
        }}
        onPointerDown={onHeaderDragStart}
        onPointerMove={onHeaderDragMove}
        onPointerUp={onHeaderDragEnd}
        onDoubleClick={onDoubleClick}
      >
        <div className="size-2.5 rounded-full" style={{ backgroundColor: group.color }} />
        <span className="text-xs font-medium text-foreground/80">{group.label}</span>
        <button
          className="ml-auto text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            deleteGroup(group.id);
          }}
        >
          x
        </button>
      </div>
    </div>
  );
}
