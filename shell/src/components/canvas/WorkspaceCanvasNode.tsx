"use client";

import { Terminal, GitPullRequest, ClipboardCheck, FileText, Eye, AppWindow, CircleDot, AlertTriangle } from "lucide-react";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { useTheme } from "@/hooks/useTheme";
import type { WorkspaceCanvasNode as WorkspaceCanvasNodeModel } from "@/stores/workspace-canvas-store";
import { useWorkspaceCanvasStore } from "@/stores/workspace-canvas-store";
import { WorkspaceCanvasFallbackNode } from "./WorkspaceCanvasFallbackNode";

function titleForNode(node: WorkspaceCanvasNodeModel): string {
  return String(node.metadata.title ?? node.metadata.label ?? node.type.replaceAll("_", " "));
}

function Icon({ type }: { type: WorkspaceCanvasNodeModel["type"] }) {
  if (type === "terminal") return <Terminal size={16} />;
  if (type === "pr") return <GitPullRequest size={16} />;
  if (type === "review_loop" || type === "finding") return <ClipboardCheck size={16} />;
  if (type === "file" || type === "note" || type === "task") return <FileText size={16} />;
  if (type === "preview") return <Eye size={16} />;
  if (type === "app_window") return <AppWindow size={16} />;
  if (type === "fallback") return <AlertTriangle size={16} />;
  return <CircleDot size={16} />;
}

export function WorkspaceCanvasNode({ node }: { node: WorkspaceCanvasNodeModel }) {
  const theme = useTheme();
  const focusedNodeId = useWorkspaceCanvasStore((s) => s.focusedNodeId);
  const setSelectedNode = useWorkspaceCanvasStore((s) => s.setSelectedNode);
  const setFocusedNode = useWorkspaceCanvasStore((s) => s.setFocusedNode);
  const executeAction = useWorkspaceCanvasStore((s) => s.executeAction);
  const isFocused = focusedNodeId === node.id;
  const terminalSessionId = node.type === "terminal" && node.sourceRef?.id !== "unattached" ? node.sourceRef?.id : undefined;

  if (node.type === "fallback" || node.displayState === "recoverable" || node.displayState === "missing") {
    return <WorkspaceCanvasFallbackNode node={node} />;
  }

  return (
    <div
      className="h-full overflow-hidden rounded-md border border-white/15 bg-zinc-950/90 text-zinc-100 shadow-xl"
      onClick={() => setSelectedNode(node.id)}
      onDoubleClick={() => setFocusedNode(isFocused ? null : node.id)}
    >
      <div className="flex h-9 items-center gap-2 border-b border-white/10 px-3 text-xs">
        <Icon type={node.type} />
        <span className="min-w-0 flex-1 truncate font-medium">{titleForNode(node)}</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300">{node.displayState}</span>
      </div>
      {node.type === "terminal" && isFocused && terminalSessionId ? (
        <TerminalPane
          paneId={`canvas-${node.id}`}
          cwd="projects"
          theme={theme}
          isFocused
          sessionId={terminalSessionId}
          shouldCacheOnUnmount={() => true}
          shouldDestroyOnUnmount={() => false}
        />
      ) : (
        <div className="space-y-2 p-3 text-xs text-zinc-300">
          {node.type === "terminal" && (
            <button
              type="button"
              className="rounded bg-emerald-500 px-2 py-1 text-xs font-medium text-emerald-950"
              onClick={() => void executeAction(node.id, terminalSessionId ? "terminal.attach" : "terminal.create", terminalSessionId ? { sessionId: terminalSessionId } : { cwd: "projects" })}
            >
              {terminalSessionId ? "Attach" : "Create terminal"}
            </button>
          )}
          {node.type === "review_loop" && (
            <div>State: {String(node.metadata.state ?? "idle")}</div>
          )}
          {node.type === "pr" && (
            <div>PR #{String(node.metadata.number ?? "")} {String(node.metadata.owner ?? "")}/{String(node.metadata.repo ?? "")}</div>
          )}
          {node.type === "preview" && (
            <div>{String(node.sourceRef?.id ?? node.metadata.url ?? "Preview")}</div>
          )}
          {node.type !== "terminal" && node.type !== "pr" && node.type !== "review_loop" && (
            <div>{String(node.metadata.text ?? node.metadata.summary ?? node.sourceRef?.id ?? "Workspace node")}</div>
          )}
        </div>
      )}
    </div>
  );
}
