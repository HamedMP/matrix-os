"use client";

import type { WorkspaceCanvasNode } from "@/stores/workspace-canvas-store";

export function WorkspaceCanvasFallbackNode({ node }: { node: WorkspaceCanvasNode }) {
  return (
    <div className="h-full rounded border border-amber-400/40 bg-amber-950/40 p-3 text-amber-50">
      <div className="text-sm font-medium">Recoverable node</div>
      <div className="mt-2 text-xs text-amber-100/80">{String(node.metadata.recoveryReason ?? node.displayState)}</div>
    </div>
  );
}
