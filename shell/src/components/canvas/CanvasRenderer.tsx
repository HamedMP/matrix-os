"use client";

import { useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useCanvasGroups } from "@/stores/canvas-groups";
import { useCanvasLabels } from "@/stores/canvas-labels";
import { CanvasTransform } from "./CanvasTransform";
import { CanvasWindow } from "./CanvasWindow";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import { CanvasGroupRect } from "./CanvasGroup";
import { CanvasTextLabel } from "./CanvasTextLabel";
import { SelectionRect } from "./SelectionRect";
import { autoArrangeWindows } from "./CanvasToolbar";
import { CanvasMinimap } from "./CanvasMinimap";

const GROUP_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

interface CanvasRendererProps {
  children?: ReactNode;
}

export function CanvasRenderer({ children }: CanvasRendererProps = {}) {
  const windows = useWindowManager((s) => s.windows);
  const focusedWindowId = useWindowManager((s) => s.focusedWindowId);
  const clearFocus = useWindowManager((s) => s.clearFocus);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const groups = useCanvasGroups((s) => s.groups);
  const createGroup = useCanvasGroups((s) => s.createGroup);
  const addToGroup = useCanvasGroups((s) => s.addToGroup);
  const labels = useCanvasLabels((s) => s.labels);

  const autoArrange = useCallback(
    (wins: typeof windows) => {
      if (wins.length === 0) return;
      const cols = 3;
      const gap = 20;
      const wm = useWindowManager.getState();
      for (let i = 0; i < wins.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = gap + col * (640 + gap);
        const y = gap + row * (480 + gap);
        wm.moveWindow(wins[i].id, x, y);
      }
      const arranged = useWindowManager.getState().windows;
      const cRect = useCanvasTransform.getState().containerRect;
      fitAll(
        arranged.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
        cRect?.width ?? window.innerWidth,
        cRect?.height ?? window.innerHeight,
      );
    },
    [fitAll],
  );

  const onSelect = useCallback(
    (windowIds: string[]) => {
      if (windowIds.length < 2) return;
      const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
      const label = `Group ${groups.length + 1}`;
      const groupId = createGroup(label, color);
      for (const winId of windowIds) {
        addToGroup(groupId, winId);
      }
    },
    [groups.length, createGroup, addToGroup],
  );

  const createLabel = useCanvasLabels((s) => s.createLabel);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);

  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget) return;
      const canvas = screenToCanvas(e.clientX, e.clientY);
      createLabel("Label", canvas.x, canvas.y);
    },
    [screenToCanvas, createLabel],
  );

  // Minimized windows stay mounted (display:none in CanvasWindow) so their
  // iframe / terminal state survives a minimize -> restore round-trip. We
  // still derive a visible-windows list for empty-state and fit-all logic.
  const visibleWindows = windows.filter((w) => !w.minimized);

  const handleFitAll = useCallback(() => {
    const wins = useWindowManager.getState().windows.filter((w) => !w.minimized);
    const cRect = useCanvasTransform.getState().containerRect;
    fitAll(
      wins.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      cRect?.width ?? window.innerWidth,
      cRect?.height ?? window.innerHeight,
    );
  }, [fitAll]);

  // Keyboard shortcuts for canvas mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key;

      if (key === "k" && e.shiftKey) {
        e.preventDefault();
        autoArrangeWindows();
      } else if (key === "0") {
        e.preventDefault();
        handleFitAll();
      } else if (key === "1") {
        e.preventDefault();
        useCanvasTransform.getState().resetZoom();
      } else if (key === "=" || key === "+") {
        e.preventDefault();
        useCanvasTransform.getState().zoomIn();
      } else if (key === "-") {
        e.preventDefault();
        useCanvasTransform.getState().zoomOut();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleFitAll]);

  return (
    <div className="relative w-full h-full">
      <CanvasTransform
        className="w-full h-full"
        onDoubleClick={onCanvasDoubleClick}
        panEnabled={!focusedWindowId}
        onBackgroundPointerDown={clearFocus}
      >
        <SelectionRect onSelect={onSelect} />
        {labels.map((label) => (
          <CanvasTextLabel key={label.id} label={label} />
        ))}
        {groups.map((group) => (
          <CanvasGroupRect key={group.id} group={group} />
        ))}
        {visibleWindows.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-white/50 drop-shadow-md">
              No apps running. Try &quot;Build me a notes app&quot; in the chat.
            </p>
          </div>
        )}
        {children}
        {windows.map((win) => (
          <CanvasWindow key={win.id} win={win} hidden={win.minimized} />
        ))}
      </CanvasTransform>
      <WorkspaceCanvas />
      <CanvasMinimap />
    </div>
  );
}
