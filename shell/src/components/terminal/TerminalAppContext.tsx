import { createContext, use, type MouseEventHandler, type PointerEventHandler } from "react";

import type { TerminalCompatMode } from "@/stores/terminal-store";
import type { Tab } from "./terminal-layout";

export interface TerminalWindowControls {
  close?: () => void;
  minimize?: () => void;
  toggleFullscreen?: () => void;
  dragHandleProps?: TerminalWindowDragHandleProps;
}

export interface TerminalWindowDragHandleProps {
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
}

export interface CreateShellSessionTabOptions {
  cmd?: string;
  agent?: "claude" | "codex" | "opencode" | "pi";
  compatMode?: TerminalCompatMode;
}

export interface TerminalAppContextType {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;
  mobile: boolean;
  windowControls?: TerminalWindowControls;
  terminalBackground: string;
  addTab: (cwd: string, label?: string, claude?: boolean, startupCommand?: string) => string;
  addSessionTab: (label: string, sessionId: string, cwd?: string) => string;
  createShellSessionTab: (label: string, cwd?: string, options?: CreateShellSessionTabOptions) => Promise<string | null>;
  backgroundShellSession: (sessionId: string) => void;
  removeDeletedShellSessionFromLayout: (sessionId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  renameShellSession: (fromSessionId: string, toSessionId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  splitPane: (paneId: string, dir: "horizontal" | "vertical") => void;
  closePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  setSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSidebarWidth: (width: number | ((prev: number) => number)) => void;
  setSidebarSelectedPath: (path: string | null) => void;
}

export const TerminalAppContext = createContext<TerminalAppContextType | null>(null);

export function useTerminalAppContext() {
  const ctx = use(TerminalAppContext);
  if (!ctx) throw new Error("Must be inside TerminalApp");
  return ctx;
}
