"use client";

import { AppWindow, FileText, Filter, GitPullRequest, Monitor, Plus, Search, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspaceCanvasStore, type WorkspaceCanvasNodeType } from "@/stores/workspace-canvas-store";

const NODE_TYPES: Array<{ type: WorkspaceCanvasNodeType; label: string; icon: ReactNode }> = [
  { type: "note", label: "Note", icon: <FileText size={14} /> },
  { type: "terminal", label: "Terminal", icon: <Terminal size={14} /> },
  { type: "preview", label: "Preview", icon: <Monitor size={14} /> },
  { type: "file", label: "File", icon: <FileText size={14} /> },
  { type: "app_window", label: "App", icon: <AppWindow size={14} /> },
  { type: "issue", label: "Issue", icon: <GitPullRequest size={14} /> },
];

export function WorkspaceCanvasToolbar() {
  const query = useWorkspaceCanvasStore((s) => s.query);
  const setQuery = useWorkspaceCanvasStore((s) => s.setQuery);
  const addNode = useWorkspaceCanvasStore((s) => s.addNode);
  const toggleFilter = useWorkspaceCanvasStore((s) => s.toggleFilter);
  const focusedNodeId = useWorkspaceCanvasStore((s) => s.focusedNodeId);
  const setFocusedNode = useWorkspaceCanvasStore((s) => s.setFocusedNode);

  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/10 bg-zinc-950/90 p-2 text-zinc-100 shadow-lg">
      <div className="flex items-center gap-1 rounded bg-white/10 px-2">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 w-44 bg-transparent text-xs outline-none"
          placeholder="Search canvas"
        />
      </div>
      {NODE_TYPES.map((item) => (
        <button
          key={item.type}
          type="button"
          className="flex h-8 items-center gap-1 rounded px-2 text-xs hover:bg-white/10"
          title={`Add ${item.label}`}
          onClick={() => void addNode(item.type, { label: item.label })}
        >
          {item.icon}
          <Plus size={12} />
        </button>
      ))}
      <button
        type="button"
        className="flex h-8 items-center gap-1 rounded px-2 text-xs hover:bg-white/10"
        title="Toggle terminal filter"
        onClick={() => toggleFilter("terminal")}
      >
        <Filter size={14} />
        Term
      </button>
      {focusedNodeId && (
        <button
          type="button"
          className="h-8 rounded px-2 text-xs hover:bg-white/10"
          onClick={() => setFocusedNode(null)}
        >
          Clear focus
        </button>
      )}
    </div>
  );
}
