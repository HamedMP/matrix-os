"use client";

import { useCallback, useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { useTerminalStore } from "@/stores/terminal-store";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  gitStatus: string | null;
  changedCount?: number;
}

interface TreeNode extends FileEntry {
  path: string;
  children?: TreeNode[];
  expanded?: boolean;
}

const GIT_STATUS_COLORS: Record<string, string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  untracked: "var(--success)",
  deleted: "var(--destructive)",
  renamed: "var(--primary)",
};

export function TerminalSidebar() {
  const sidebarOpen = useTerminalStore((s) => s.sidebarOpen);
  const setSidebarOpen = useTerminalStore((s) => s.setSidebarOpen);
  const sidebarSelectedPath = useTerminalStore((s) => s.sidebarSelectedPath);
  const setSidebarSelectedPath = useTerminalStore((s) => s.setSidebarSelectedPath);
  const addTab = useTerminalStore((s) => s.addTab);

  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);

  const fetchDir = useCallback(async (path: string): Promise<FileEntry[]> => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/files/tree?path=${encodeURIComponent(path)}`);
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }, []);

  const loadRoot = useCallback(async () => {
    const entries = await fetchDir(rootPath);
    setTree(entries.map((e) => ({ ...e, path: `${rootPath}/${e.name}` })));
  }, [rootPath, fetchDir]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const toggleExpand = useCallback(
    async (node: TreeNode) => {
      if (node.type !== "directory") return;

      if (node.expanded) {
        setTree((prev) => updateNodeInTree(prev, node.path, { expanded: false }));
        return;
      }

      const children = await fetchDir(node.path);
      const childNodes = children.map((c) => ({ ...c, path: `${node.path}/${c.name}` }));
      setTree((prev) => updateNodeInTree(prev, node.path, { expanded: true, children: childNodes }));
    },
    [fetchDir],
  );

  const navigateUp = useCallback(() => {
    if (rootPath === "" || rootPath === ".") return;
    const parts = rootPath.split("/").filter(Boolean);
    parts.pop();
    setRootPath(parts.join("/") || "");
  }, [rootPath]);

  const handleSelect = useCallback(
    (node: TreeNode) => {
      if (node.type === "directory") {
        setSidebarSelectedPath(node.path);
      }
    },
    [setSidebarSelectedPath],
  );

  const handleOpenTerminal = useCallback(
    (path: string) => {
      addTab(path);
    },
    [addTab],
  );

  if (!sidebarOpen) {
    return (
      <div
        className="flex flex-col items-center py-2 gap-2 shrink-0"
        style={{
          width: 36,
          background: "var(--card)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <IconButton title="Files" onClick={() => setSidebarOpen(true)}>
          &#128193;
        </IconButton>
      </div>
    );
  }

  const isAtRoot = rootPath === "" || rootPath === ".";
  const displayRoot = rootPath || "~";

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: 200,
        background: "var(--card)",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1.5 text-[10px] shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <IconButton title="Files" onClick={() => setSidebarOpen(false)}>
          &#128193;
        </IconButton>
        {!isAtRoot && (
          <button
            className="text-xs opacity-60 hover:opacity-100 cursor-pointer"
            onClick={navigateUp}
            title="Navigate up"
            style={{ color: "var(--muted-foreground)" }}
          >
            ..
          </button>
        )}
        <span className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {displayRoot}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1 text-xs">
        {tree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={sidebarSelectedPath}
            onToggle={toggleExpand}
            onSelect={handleSelect}
            onOpenTerminal={handleOpenTerminal}
          />
        ))}
        {tree.length === 0 && (
          <div className="px-3 py-4 text-center" style={{ color: "var(--muted-foreground)" }}>
            Empty directory
          </div>
        )}
      </div>
    </div>
  );
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onToggle: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  onOpenTerminal: (path: string) => void;
}

function FileTreeNode({ node, depth, selectedPath, onToggle, onSelect, onOpenTerminal }: FileTreeNodeProps) {
  const isSelected = selectedPath === node.path;
  const gitColor = node.gitStatus ? GIT_STATUS_COLORS[node.gitStatus] : undefined;

  const handleClick = useCallback(() => {
    if (node.type === "directory") {
      onToggle(node);
      onSelect(node);
    }
  }, [node, onToggle, onSelect]);

  const handleDoubleClick = useCallback(() => {
    if (node.type === "directory") {
      onOpenTerminal(node.path);
    }
  }, [node, onOpenTerminal]);

  return (
    <>
      <div
        className="flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-[var(--accent)] transition-colors"
        style={{
          paddingLeft: 8 + depth * 12,
          background: isSelected ? "var(--accent)" : undefined,
          color: gitColor ?? "var(--foreground)",
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {node.type === "directory" ? (
          <span className="text-[10px] opacity-60" style={{ width: 10 }}>
            {node.expanded ? "▾" : "▸"}
          </span>
        ) : (
          <span style={{ width: 10 }} />
        )}
        <span className="truncate flex-1">{node.name}</span>
        {node.type === "directory" && node.changedCount !== undefined && node.changedCount > 0 && (
          <span
            className="text-[9px] px-1 rounded"
            style={{ background: "var(--warning)", color: "var(--card)", opacity: 0.8 }}
          >
            {node.changedCount}
          </span>
        )}
      </div>
      {node.expanded && node.children?.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onOpenTerminal={onOpenTerminal}
        />
      ))}
    </>
  );
}

function updateNodeInTree(nodes: TreeNode[], path: string, update: Partial<TreeNode>): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, ...update };
    }
    if (node.children) {
      return { ...node, children: updateNodeInTree(node.children, path, update) };
    }
    return node;
  });
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="flex items-center justify-center rounded cursor-pointer hover:bg-[var(--accent)] transition-colors"
      style={{ width: 24, height: 24, fontSize: 14 }}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
