"use client";

import { useEffect } from "react";
import { Tldraw } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { useWorkspaceCanvasStore } from "@/stores/workspace-canvas-store";
import { WorkspaceCanvasNode } from "./WorkspaceCanvasNode";
import { WorkspaceCanvasToolbar } from "./WorkspaceCanvasToolbar";
import { WorkspaceCanvasInspector } from "./WorkspaceCanvasInspector";

export function WorkspaceCanvas() {
  const document = useWorkspaceCanvasStore((s) => s.document);
  const summaries = useWorkspaceCanvasStore((s) => s.summaries);
  const loadSummaries = useWorkspaceCanvasStore((s) => s.loadSummaries);
  const openCanvas = useWorkspaceCanvasStore((s) => s.openCanvas);
  const visibleNodes = useWorkspaceCanvasStore((s) => s.visibleNodes());
  const setSelectedNode = useWorkspaceCanvasStore((s) => s.setSelectedNode);

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
      <div className="absolute inset-0 opacity-0">
        <Tldraw persistenceKey={`workspace-${document.id}`} hideUi />
      </div>
      <div className="absolute left-4 top-4 z-20">
        <WorkspaceCanvasToolbar />
      </div>
      <div className="absolute right-4 top-4 z-20">
        <WorkspaceCanvasInspector />
      </div>
      <div className="absolute inset-0">
        {visibleNodes.map((node) => (
          <div
            key={node.id}
            className="pointer-events-auto absolute"
            style={{
              transform: `translate(${node.position.x}px, ${node.position.y}px)`,
              width: node.size.width,
              height: node.size.height,
              zIndex: 30 + node.zIndex,
            }}
            onMouseDown={() => setSelectedNode(node.id)}
          >
            <WorkspaceCanvasNode node={node} />
          </div>
        ))}
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          {document.edges.map((edge) => {
            const from = document.nodes.find((node) => node.id === edge.fromNodeId);
            const to = document.nodes.find((node) => node.id === edge.toNodeId);
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
      </div>
    </div>
  );
}
