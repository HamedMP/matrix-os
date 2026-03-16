"use client";

import { useCallback, useRef, useState } from "react";
import { useTerminalStore } from "@/stores/terminal-store";

interface TerminalTabBarProps {
  defaultCwd: string;
}

export function TerminalTabBar({ defaultCwd }: TerminalTabBarProps) {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const addTab = useTerminalStore((s) => s.addTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const reorderTabs = useTerminalStore((s) => s.reorderTabs);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const focusedPaneId = useTerminalStore((s) => s.focusedPaneId);
  const sidebarSelectedPath = useTerminalStore((s) => s.sidebarSelectedPath);

  const dragIndexRef = useRef<number | null>(null);

  const getCwd = useCallback(() => {
    return sidebarSelectedPath ?? defaultCwd;
  }, [sidebarSelectedPath, defaultCwd]);

  const handleNewTab = useCallback(() => {
    addTab(getCwd());
  }, [addTab, getCwd]);

  const handleLaunchClaude = useCallback(() => {
    addTab(getCwd(), "Claude Code");
  }, [addTab, getCwd]);

  const handleSplitH = useCallback(() => {
    if (focusedPaneId) splitPane(focusedPaneId, "horizontal");
  }, [focusedPaneId, splitPane]);

  const handleSplitV = useCallback(() => {
    if (focusedPaneId) splitPane(focusedPaneId, "vertical");
  }, [focusedPaneId, splitPane]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      const fromIndex = dragIndexRef.current;
      if (fromIndex !== null && fromIndex !== toIndex) {
        reorderTabs(fromIndex, toIndex);
      }
      dragIndexRef.current = null;
    },
    [reorderTabs],
  );

  return (
    <div
      className="flex items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: 34,
      }}
    >
      <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            index={index}
            onClick={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, index)}
          />
        ))}
      </div>

      <div className="flex items-center gap-1 px-2 shrink-0">
        <BarButton
          label="Claude Code"
          onClick={handleLaunchClaude}
          style={{ background: "var(--success)", color: "white", borderRadius: 4, padding: "2px 8px" }}
        />
        <BarButton label="Split H" onClick={handleSplitH} title="Split horizontal">
          &#8862;
        </BarButton>
        <BarButton label="Split V" onClick={handleSplitV} title="Split vertical">
          &#8863;
        </BarButton>
        <BarButton label="New Tab" onClick={handleNewTab} title="New tab">
          +
        </BarButton>
      </div>
    </div>
  );
}

interface TabItemProps {
  label: string;
  isActive: boolean;
  index: number;
  onClick: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

function TabItem({ label, isActive, onClick, onClose, onDragStart, onDragOver, onDrop }: TabItemProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const tabs = useTerminalStore((s) => s.tabs);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const addTab = useTerminalStore((s) => s.addTab);

  const tabId = tabs.find((t) => t.label === label)?.id;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRename = useCallback(() => {
    setContextMenu(null);
    if (!tabId) return;
    const newName = prompt("Tab name:", label);
    if (newName) renameTab(tabId, newName);
  }, [tabId, label, renameTab]);

  const handleDuplicate = useCallback(() => {
    setContextMenu(null);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      const pane = tab.paneTree;
      const cwd = pane.type === "pane" ? pane.cwd : "";
      addTab(cwd, tab.label + " (copy)");
    }
  }, [tabId, tabs, addTab]);

  const handleCloseOthers = useCallback(() => {
    setContextMenu(null);
    tabs.forEach((t) => {
      if (t.id !== tabId) closeTab(t.id);
    });
  }, [tabId, tabs, closeTab]);

  return (
    <>
      <div
        className="flex items-center gap-1.5 px-3 text-xs cursor-pointer whitespace-nowrap"
        style={{
          background: isActive ? "var(--background)" : "transparent",
          borderRight: "1px solid var(--border)",
          borderTop: isActive ? "2px solid var(--primary)" : "2px solid transparent",
          color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
        }}
        draggable
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <span
          className="size-1.5 rounded-full"
          style={{ background: "var(--success)" }}
        />
        <span>{label}</span>
        <button
          className="ml-1 opacity-40 hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{ color: "var(--muted-foreground)" }}
        >
          x
        </button>
      </div>
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 rounded shadow-lg border text-xs"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              background: "var(--popover)",
              borderColor: "var(--border)",
              color: "var(--popover-foreground)",
            }}
          >
            <button className="block w-full text-left px-3 py-1.5 hover:bg-[var(--accent)]" onClick={handleRename}>
              Rename
            </button>
            <button className="block w-full text-left px-3 py-1.5 hover:bg-[var(--accent)]" onClick={handleDuplicate}>
              Duplicate
            </button>
            <button className="block w-full text-left px-3 py-1.5 hover:bg-[var(--accent)]" onClick={handleCloseOthers}>
              Close Others
            </button>
          </div>
        </>
      )}
    </>
  );
}

interface BarButtonProps {
  label: string;
  onClick: () => void;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

function BarButton({ label, onClick, title, style, children }: BarButtonProps) {
  return (
    <button
      className="text-xs cursor-pointer hover:opacity-80 transition-opacity"
      style={{ color: "var(--muted-foreground)", ...style }}
      onClick={onClick}
      title={title ?? label}
    >
      {children ?? label}
    </button>
  );
}
