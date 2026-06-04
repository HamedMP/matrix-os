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
import { autoArrangeWindows } from "./canvas-auto-arrange";
import { CanvasMinimap } from "./CanvasMinimap";

const GROUP_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
const APP_HYDRATION_MARGIN_PX = 320;

interface CanvasRendererProps {
  children?: ReactNode;
}

export function shouldHydrateCanvasWindow(input: {
  window: { x: number; y: number; width: number; height: number; path: string; minimized?: boolean };
  focusedWindowId: string | null;
  windowId: string;
  zoom: number;
  panX: number;
  panY: number;
  viewportWidth: number;
  viewportHeight: number;
}): boolean {
  if (input.window.path.startsWith("__")) return true;
  if (input.focusedWindowId === input.windowId) return true;

  const left = (input.window.x + input.panX) * input.zoom;
  const top = (input.window.y + input.panY) * input.zoom;
  const right = left + input.window.width * input.zoom;
  const bottom = top + input.window.height * input.zoom;
  return (
    right >= -APP_HYDRATION_MARGIN_PX &&
    bottom >= -APP_HYDRATION_MARGIN_PX &&
    left <= input.viewportWidth + APP_HYDRATION_MARGIN_PX &&
    top <= input.viewportHeight + APP_HYDRATION_MARGIN_PX
  );
}

export function CanvasRenderer({ children }: CanvasRendererProps = {}) {
  const windows = useWindowManager((s) => s.windows);
  const focusedWindowId = useWindowManager((s) => s.focusedWindowId);
  const clearFocus = useWindowManager((s) => s.clearFocus);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const zoom = useCanvasTransform((s) => s.zoom);
  const panX = useCanvasTransform((s) => s.panX);
  const panY = useCanvasTransform((s) => s.panY);
  const containerRect = useCanvasTransform((s) => s.containerRect);
  const groups = useCanvasGroups((s) => s.groups);
  const createGroup = useCanvasGroups((s) => s.createGroup);
  const addToGroup = useCanvasGroups((s) => s.addToGroup);
  const labels = useCanvasLabels((s) => s.labels);
  const viewportWidth = containerRect?.width ?? (typeof window !== "undefined" ? window.innerWidth : 0);
  const viewportHeight = containerRect?.height ?? (typeof window !== "undefined" ? window.innerHeight : 0);

  const onSelect = (windowIds: string[]) => {
    if (windowIds.length < 2) return;
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
    const label = `Group ${groups.length + 1}`;
    const groupId = createGroup(label, color);
    for (const winId of windowIds) {
      addToGroup(groupId, winId);
    }
  };

  const createLabel = useCanvasLabels((s) => s.createLabel);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const canvas = screenToCanvas(e.clientX, e.clientY);
    createLabel("Label", canvas.x, canvas.y);
  };

  // Minimized windows stay mounted (display:none in CanvasWindow) so their
  // iframe / terminal state survives a minimize -> restore round-trip. Offscreen
  // non-built-in app windows can still defer at boot via shouldHydrateCanvasWindow.
  // We still derive a visible-windows list for empty-state and fit-all logic.
  const visibleWindows = windows.filter((w) => !w.minimized);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity required: this handler is a dependency of the keydown-listener effect below and re-binds the global window keydown listener on identity change. Inlining would detach/reattach the listener every render.
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
        {windows.map((win) => {
          const hydrateContent = shouldHydrateCanvasWindow({
            window: win,
            windowId: win.id,
            focusedWindowId,
            zoom,
            panX,
            panY,
            viewportWidth,
            viewportHeight,
          });
          return (
            <CanvasWindow
              key={win.id}
              win={win}
              hidden={win.minimized}
              deferAppContent={!hydrateContent}
            />
          );
        })}
      </CanvasTransform>
      <WorkspaceCanvas />
      <CanvasMinimap />
    </div>
  );
}
