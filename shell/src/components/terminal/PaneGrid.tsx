"use client";

import { useRef, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import type { PaneNode } from "@/stores/terminal-store";
import type { Theme } from "@/hooks/useTheme";

interface PaneGridProps {
  paneTree: PaneNode;
  theme: Theme;
  focusedPaneId?: string | null;
  onFocusPane?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  shouldCachePane?: (paneId: string) => boolean;
  shouldDestroyPane?: (paneId: string) => boolean;
  allowRemoteResize?: boolean;
  suppressNativeKeyboard?: boolean;
  canvasZoom?: number;
}

export function PaneGrid({ paneTree, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane, allowRemoteResize = true, suppressNativeKeyboard = false, canvasZoom = 1 }: PaneGridProps) {
  return (
    <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
      <PaneNodeRenderer
        node={paneTree}
        theme={theme}
        focusedPaneId={focusedPaneId}
        onFocusPane={onFocusPane}
        onSessionAttached={onSessionAttached}
        shouldCachePane={shouldCachePane}
        shouldDestroyPane={shouldDestroyPane}
        allowRemoteResize={allowRemoteResize}
        suppressNativeKeyboard={suppressNativeKeyboard}
        canvasZoom={canvasZoom}
      />
    </div>
  );
}

interface PaneNodeRendererProps {
  node: PaneNode;
  theme: Theme;
  focusedPaneId?: string | null;
  onFocusPane?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  shouldCachePane?: (paneId: string) => boolean;
  shouldDestroyPane?: (paneId: string) => boolean;
  allowRemoteResize?: boolean;
  suppressNativeKeyboard?: boolean;
  canvasZoom?: number;
}

function PaneNodeRenderer({ node, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane, allowRemoteResize = true, suppressNativeKeyboard = false, canvasZoom = 1 }: PaneNodeRendererProps) {
  if (node.type === "pane") {
    const focused = focusedPaneId === node.id;
    return (
      <div
        key={node.id}
        className="h-full w-full min-h-0 min-w-0"
        style={{
          boxShadow: focused
            ? "inset 0 0 0 2px var(--primary), inset 0 0 0 3px color-mix(in srgb, var(--background) 68%, transparent)"
            : "inset 0 0 0 1px color-mix(in srgb, var(--border) 62%, transparent)",
          position: "relative",
        }}
      >
        <TerminalPane
          key={node.id}
          paneId={node.id}
          cwd={node.cwd}
          theme={theme}
          isFocused={focused}
          sessionId={node.sessionId}
          claudeMode={node.claudeMode === true}
          startupCommand={node.startupCommand}
          compatMode={node.compatMode}
          onFocus={onFocusPane}
          onSessionAttached={onSessionAttached}
          shouldCacheOnUnmount={shouldCachePane}
          shouldDestroyOnUnmount={shouldDestroyPane}
          allowRemoteResize={allowRemoteResize}
          suppressNativeKeyboard={suppressNativeKeyboard}
          canvasZoom={canvasZoom}
        />
      </div>
    );
  }

  return (
    <SplitContainer
      direction={node.direction}
      ratio={node.ratio}
      left={node.children[0]}
      right={node.children[1]}
      theme={theme}
      focusedPaneId={focusedPaneId}
      onFocusPane={onFocusPane}
      onSessionAttached={onSessionAttached}
      shouldCachePane={shouldCachePane}
      shouldDestroyPane={shouldDestroyPane}
      allowRemoteResize={allowRemoteResize}
      suppressNativeKeyboard={suppressNativeKeyboard}
      canvasZoom={canvasZoom}
    />
  );
}

interface SplitContainerProps {
  direction: "horizontal" | "vertical";
  ratio: number;
  left: PaneNode;
  right: PaneNode;
  theme: Theme;
  focusedPaneId?: string | null;
  onFocusPane?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  shouldCachePane?: (paneId: string) => boolean;
  shouldDestroyPane?: (paneId: string) => boolean;
  allowRemoteResize?: boolean;
  suppressNativeKeyboard?: boolean;
  canvasZoom?: number;
}

function SplitContainer({ direction, ratio, left, right, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane, allowRemoteResize = true, suppressNativeKeyboard = false, canvasZoom = 1 }: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- local drag buffer, not a mirror of `ratio`: it is seeded from the prop, then diverges live as the user drags the split divider (setCurrentRatio in onMouseMove). It must NOT stay in sync with `ratio` or the divider would snap back mid-drag; it holds uncommitted pointer-driven layout state.
  const [currentRatio, setCurrentRatio] = useState(ratio);

  const isHorizontal = direction === "horizontal";

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();

    function onMouseMove(ev: MouseEvent) {
      const pos = isHorizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      setCurrentRatio(Math.max(0.15, Math.min(0.85, pos)));
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const firstSize = `${currentRatio * 100}%`;
  const secondSize = `${(1 - currentRatio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-h-0 min-w-0"
      style={{ display: "flex", flexDirection: isHorizontal ? "row" : "column" }}
    >
      <div style={{ [isHorizontal ? "width" : "height"]: firstSize, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <PaneNodeRenderer
          node={left}
          theme={theme}
          focusedPaneId={focusedPaneId}
          onFocusPane={onFocusPane}
          onSessionAttached={onSessionAttached}
          shouldCachePane={shouldCachePane}
          shouldDestroyPane={shouldDestroyPane}
          allowRemoteResize={allowRemoteResize}
          suppressNativeKeyboard={suppressNativeKeyboard}
          canvasZoom={canvasZoom}
        />
      </div>
      {/* react-doctor-disable-next-line react-doctor/no-static-element-interactions -- presentational pointer-only resize affordance: the 4px gutter starts a mouse/pointer drag to repan the split. It carries no control semantics, has no keyboard equivalent (panes auto-fit on resize), and adding an interactive role would require a non-trivial keyboard-resize behavior change out of scope for this pass. */}
      <div
        className="shrink-0 hover:opacity-100 opacity-50 transition-opacity"
        style={{ [isHorizontal ? "width" : "height"]: "4px", cursor: isHorizontal ? "col-resize" : "row-resize", background: "var(--border)" }}
        onMouseDown={handleDragStart}
      />
      <div style={{ [isHorizontal ? "width" : "height"]: secondSize, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <PaneNodeRenderer
          node={right}
          theme={theme}
          focusedPaneId={focusedPaneId}
          onFocusPane={onFocusPane}
          onSessionAttached={onSessionAttached}
          shouldCachePane={shouldCachePane}
          shouldDestroyPane={shouldDestroyPane}
          allowRemoteResize={allowRemoteResize}
          suppressNativeKeyboard={suppressNativeKeyboard}
          canvasZoom={canvasZoom}
        />
      </div>
    </div>
  );
}
