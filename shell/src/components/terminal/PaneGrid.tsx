"use client";

import { useCallback, useRef, useState } from "react";
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
}

export function PaneGrid({ paneTree, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane }: PaneGridProps) {
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
}

function PaneNodeRenderer({ node, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane }: PaneNodeRendererProps) {
  if (node.type === "pane") {
    return (
      <div key={node.id} className="h-full w-full min-h-0 min-w-0">
        <TerminalPane
          key={node.id}
          paneId={node.id}
          cwd={node.cwd}
          theme={theme}
          isFocused={focusedPaneId === node.id}
          sessionId={node.sessionId}
          claudeMode={node.claudeMode === true}
          startupCommand={node.startupCommand}
          onFocus={onFocusPane}
          onSessionAttached={onSessionAttached}
          shouldCacheOnUnmount={shouldCachePane}
          shouldDestroyOnUnmount={shouldDestroyPane}
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
}

function SplitContainer({ direction, ratio, left, right, theme, focusedPaneId, onFocusPane, onSessionAttached, shouldCachePane, shouldDestroyPane }: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);

  const isHorizontal = direction === "horizontal";

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [isHorizontal],
  );

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
        />
      </div>
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
        />
      </div>
    </div>
  );
}
