"use client";

import { useWorkspaceCanvasStore } from "@/stores/workspace-canvas-store";

export function WorkspaceCanvasInspector() {
  const document = useWorkspaceCanvasStore((s) => s.document);
  const selectedNodeId = useWorkspaceCanvasStore((s) => s.selectedNodeId);
  const saveStatus = useWorkspaceCanvasStore((s) => s.saveStatus);
  const error = useWorkspaceCanvasStore((s) => s.error);
  const executeAction = useWorkspaceCanvasStore((s) => s.executeAction);
  const selected = document?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <aside className="pointer-events-auto w-72 rounded-md border border-white/10 bg-zinc-950/90 p-3 text-xs text-zinc-100 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="font-medium">{selected ? selected.type.replaceAll("_", " ") : "Workspace"}</span>
        <span className="text-zinc-400">{saveStatus}</span>
      </div>
      {error && <div className="mt-2 rounded bg-red-950/70 p-2 text-red-100">{error}</div>}
      {selected ? (
        <div className="mt-3 space-y-2">
          <div className="break-all text-zinc-300">{selected.id}</div>
          <div>State: {selected.displayState}</div>
          {selected.type === "review_loop" && (
            <div className="flex gap-2">
              {["review.start", "review.next", "review.approve", "review.stop"].map((type) => (
                <button key={type} type="button" className="rounded bg-white/10 px-2 py-1 hover:bg-white/15" onClick={() => void executeAction(selected.id, type)}>
                  {type.split(".")[1]}
                </button>
              ))}
            </div>
          )}
          {selected.displayState === "recoverable" && (
            <div className="rounded bg-amber-950/50 p-2 text-amber-100">Reference is missing. The node is retained for recovery.</div>
          )}
        </div>
      ) : (
        <div className="mt-3 text-zinc-400">{document ? `${document.nodes.length} nodes, ${document.edges.length} edges` : "No canvas selected"}</div>
      )}
    </aside>
  );
}
