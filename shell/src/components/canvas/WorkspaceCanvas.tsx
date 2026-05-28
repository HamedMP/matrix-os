"use client";

import { useEffect, useMemo, useRef } from "react";
import { Tldraw } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { selectVisibleWorkspaceCanvasNodes, useWorkspaceCanvasStore } from "@/stores/workspace-canvas-store";
import { WorkspaceCanvasNode } from "./WorkspaceCanvasNode";
import { WorkspaceCanvasToolbar } from "./WorkspaceCanvasToolbar";
import { WorkspaceCanvasInspector } from "./WorkspaceCanvasInspector";

type ImageDragState = {
  nodeId: string;
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  nextX: number;
  nextY: number;
  nextW: number;
  nextH: number;
};

function applyImageDragPreview(element: HTMLElement, drag: ImageDragState) {
  element.style.transform = `translate(${drag.nextX}px, ${drag.nextY}px)`;
  element.style.width = `${drag.nextW}px`;
  element.style.height = `${drag.nextH}px`;
}

function clearImageDragPreview(element: HTMLElement) {
  element.style.transform = "";
  element.style.width = "";
  element.style.height = "";
}

export function WorkspaceCanvasLayer() {
  const document = useWorkspaceCanvasStore((s) => s.document);
  const query = useWorkspaceCanvasStore((s) => s.query);
  const filters = useWorkspaceCanvasStore((s) => s.filters);
  const setSelectedNode = useWorkspaceCanvasStore((s) => s.setSelectedNode);
  const updateNode = useWorkspaceCanvasStore((s) => s.updateNode);
  const zoom = useCanvasTransform((s) => s.zoom);
  const dragRef = useRef<ImageDragState | null>(null);
  const visibleNodes = useMemo(() => selectVisibleWorkspaceCanvasNodes(document, query, filters), [document, filters, query]);
  const nodeById = useMemo(() => new Map(document?.nodes.map((node) => [node.id, node]) ?? []), [document?.nodes]);

  if (!document) return null;

  return (
    <>
      <div className="absolute inset-0" style={{ zIndex: -1 }} />
      {visibleNodes.map((node) => (
        <div
          key={node.id}
          className="pointer-events-auto absolute touch-none"
          style={{
            transform: `translate(${node.position.x}px, ${node.position.y}px)`,
            width: node.size.width,
            height: node.size.height,
            zIndex: 30 + node.zIndex,
          }}
          onMouseDown={() => setSelectedNode(node.id)}
          onPointerDown={(event) => {
            if (node.type !== "image" || event.button !== 0) return;
            if (event.target instanceof Element && event.target.closest("button")) return;
            const mode = event.target instanceof Element && event.target.closest("[data-workspace-canvas-resize]") ? "resize" : "move";
            event.preventDefault();
            event.stopPropagation();
            dragRef.current = {
              nodeId: node.id,
              mode,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              origX: node.position.x,
              origY: node.position.y,
              origW: node.size.width,
              origH: node.size.height,
              nextX: node.position.x,
              nextY: node.position.y,
              nextW: node.size.width,
              nextH: node.size.height,
            };
            if ("setPointerCapture" in event.currentTarget) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.nodeId !== node.id || drag.pointerId !== event.pointerId) return;
            const dx = (event.clientX - drag.startX) / zoom;
            const dy = (event.clientY - drag.startY) / zoom;
            if (drag.mode === "move") {
              drag.nextX = Math.round(drag.origX + dx);
              drag.nextY = Math.round(drag.origY + dy);
            } else {
              drag.nextW = Math.max(80, Math.round(drag.origW + dx));
              drag.nextH = Math.max(60, Math.round(drag.origH + dy));
            }
            applyImageDragPreview(event.currentTarget, drag);
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.nodeId !== node.id || drag.pointerId !== event.pointerId) return;
            dragRef.current = null;
            if ("releasePointerCapture" in event.currentTarget) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (drag.mode === "move") {
              void updateNode(node.id, { position: { x: drag.nextX, y: drag.nextY } });
            } else {
              void updateNode(node.id, { size: { width: drag.nextW, height: drag.nextH } });
            }
            clearImageDragPreview(event.currentTarget);
          }}
          onPointerCancel={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.nodeId !== node.id || drag.pointerId !== event.pointerId) return;
            dragRef.current = null;
            if (drag.mode === "move") {
              void updateNode(node.id, { position: { x: drag.origX, y: drag.origY } });
            } else {
              void updateNode(node.id, { size: { width: drag.origW, height: drag.origH } });
            }
            clearImageDragPreview(event.currentTarget);
          }}
        >
          <WorkspaceCanvasNode node={node} />
        </div>
      ))}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {document.edges.map((edge) => {
          const from = nodeById.get(edge.fromNodeId);
          const to = nodeById.get(edge.toNodeId);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.position.x + from.size.width}
              y1={from.position.y + from.size.height / 2}
              x2={to.position.x}
              y2={to.position.y + to.size.height / 2}
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={2}
            />
          );
        })}
      </svg>
    </>
  );
}

export function WorkspaceCanvas() {
  const document = useWorkspaceCanvasStore((s) => s.document);
  const summaries = useWorkspaceCanvasStore((s) => s.summaries);
  const loadSummaries = useWorkspaceCanvasStore((s) => s.loadSummaries);
  const openCanvas = useWorkspaceCanvasStore((s) => s.openCanvas);
  const tldrawLayerEnabled = document?.displayOptions.tldrawLayer === true;

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    if (!document && summaries[0]) {
      void openCanvas(summaries[0].id);
    }
  }, [document, openCanvas, summaries]);

  if (!document) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-10 pointer-events-none" data-tldraw-workspace>
      {tldrawLayerEnabled && (
        <div className="absolute inset-0 opacity-0">
          <Tldraw persistenceKey={`workspace-${document.id}`} hideUi />
        </div>
      )}
      <div className="absolute left-4 top-4 z-20">
        <WorkspaceCanvasToolbar />
      </div>
      <div className="absolute right-4 top-4 z-20">
        <WorkspaceCanvasInspector />
      </div>
    </div>
  );
}
