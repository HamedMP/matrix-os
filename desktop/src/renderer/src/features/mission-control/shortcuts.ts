import { useEffect } from "react";
import { onEvent } from "../../lib/operator";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { AGENTS_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

interface CloseTabShortcutState {
  activeTabId: string | null;
  tabs: Array<{ id: string; closable: boolean }>;
  closeTab(id: string): void;
}

interface CycleTabShortcutState {
  activeTabId: string | null;
  tabs: Array<{ id: string }>;
  focusTab(id: string): void;
}

interface TerminalFocusShortcutState {
  tabs: Array<{ id: string; kind: string }>;
  focusTab(id: string): void;
  openTab(spec: { kind: "terminals"; title: string }): void;
}

interface NewAgentRunShortcutUiState {
  composerOpen: boolean;
  setComposerOpen(open: boolean): void;
}

interface NewAgentRunShortcutTabsState {
  openTab(spec: typeof AGENTS_WORKSPACE_TAB_SPEC): void;
}

interface NewAgentRunShortcutWorkspaceState {
  summary: { capabilities: Array<{ id: string; enabled: boolean }> } | null;
  requestComposerFocus(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function isTerminalFocusShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  const meta = event.metaKey || event.ctrlKey;
  return meta && event.altKey && !event.shiftKey && event.key.toLowerCase() === "t";
}

export function handleMenuNavigate(kind: string): void {
  if (kind === "settings") {
    useTabs.getState().openTab({ kind: "settings", title: "Settings" });
    return;
  }
  if (kind === "agents") {
    useTabs.getState().openTab(AGENTS_WORKSPACE_TAB_SPEC);
    return;
  }
  if (kind === "terminals") {
    handleTerminalFocusShortcut({ preventDefault: () => undefined }, useTabs.getState());
    return;
  }
  if (kind === "board") {
    const { activeProjectSlug, projects } = useBoard.getState();
    const project = projects.find((candidate) => candidate.slug === activeProjectSlug) ?? projects[0];
    if (project) {
      useTabs.getState().openTab({
        kind: "board",
        projectSlug: project.slug,
        title: project.name || project.slug,
      });
      return;
    }
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    return;
  }
  if (kind !== "home") {
    console.warn(`[shortcuts] unsupported menu:navigate kind: ${kind}`);
  }
  useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
}

export function handleCloseTabShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
  tabs: CloseTabShortcutState,
): void {
  event.preventDefault();
  if (!tabs.activeTabId) return;
  const tab = tabs.tabs.find((t) => t.id === tabs.activeTabId);
  if (tab?.closable) {
    tabs.closeTab(tabs.activeTabId);
  }
}

export function handleCycleTabShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
  tabs: CycleTabShortcutState,
  direction: 1 | -1,
): void {
  if (tabs.tabs.length <= 1) return;
  event.preventDefault();
  const idx = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
  const nextIndex = idx === -1
    ? direction === 1 ? 0 : tabs.tabs.length - 1
    : (idx + direction + tabs.tabs.length) % tabs.tabs.length;
  const next = tabs.tabs[nextIndex];
  if (next) tabs.focusTab(next.id);
}

export function handleTerminalFocusShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
  tabs: TerminalFocusShortcutState,
): void {
  event.preventDefault();
  const existing = tabs.tabs.find((tab) => tab.kind === "terminal" || tab.kind === "terminals");
  if (existing) {
    tabs.focusTab(existing.id);
    return;
  }
  tabs.openTab({ kind: "terminals", title: "Terminal" });
}

function canRequestAgentComposerFocus(summary: NewAgentRunShortcutWorkspaceState["summary"]): boolean {
  if (!summary) return true;
  return summary.capabilities.some((capability) => capability.id === "codingAgentsThreadCreate" && capability.enabled);
}

export function handleNewAgentRunShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
  ui: NewAgentRunShortcutUiState,
  tabs: NewAgentRunShortcutTabsState,
  workspace: NewAgentRunShortcutWorkspaceState,
  options: { desktopWorkspaceEnabled?: boolean } = {},
): void {
  event.preventDefault();
  const desktopWorkspaceEnabled = options.desktopWorkspaceEnabled ?? CODING_AGENTS_DESKTOP_WORKSPACE;
  if (desktopWorkspaceEnabled) {
    if (canRequestAgentComposerFocus(workspace.summary)) workspace.requestComposerFocus();
    tabs.openTab(AGENTS_WORKSPACE_TAB_SPEC);
    return;
  }
  ui.setComposerOpen(true);
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const tabs = useTabs.getState();
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (meta && key === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (meta && key === "j") {
        handleNewAgentRunShortcut(e, ui, tabs, useCodingAgentWorkspace.getState());
        return;
      }
      if (meta && key === "p") {
        e.preventDefault();
        ui.setQuickOpenOpen(!ui.quickOpenOpen);
        return;
      }
      if (isTerminalFocusShortcut(e)) {
        handleTerminalFocusShortcut(e, tabs);
        return;
      }
      // New chat with the OS agent.
      if (meta && e.shiftKey && key === "o") {
        e.preventDefault();
        tabs.openTab({ kind: "chat", title: "Hermes", closable: false });
        return;
      }
      // New tab → Home.
      if (meta && key === "t") {
        e.preventDefault();
        tabs.openTab({ kind: "home", title: "Home", closable: false });
        return;
      }
      // Close the active tab.
      if (meta && key === "w") {
        handleCloseTabShortcut(e, tabs);
        return;
      }
      // Toggle sidebar (⌘B, like Codex; ⌘\ also works).
      if (meta && (key === "b" || e.key === "\\")) {
        e.preventDefault();
        ui.toggleSidebar();
        return;
      }
      // Cycle tabs with Ctrl+Tab / Ctrl+Shift+Tab.
      if (e.ctrlKey && e.key === "Tab" && tabs.tabs.length > 1) {
        handleCycleTabShortcut(e, tabs, e.shiftKey ? -1 : 1);
        return;
      }
      if (!meta && key === "c" && !isTypingTarget(e.target)) {
        if (ui.paletteOpen || ui.composerOpen || ui.createTaskOpen) return;
        e.preventDefault();
        ui.setCreateTaskOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const offAction = onEvent("menu:action", ({ action }) => {
      const ui = useUi.getState();
      if (action === "new-task") ui.setCreateTaskOpen(true);
      if (action === "new-thread") {
        handleNewAgentRunShortcut({ preventDefault: () => undefined }, ui, useTabs.getState(), useCodingAgentWorkspace.getState());
      }
      if (action === "palette") ui.setPaletteOpen(!ui.paletteOpen);
      if (action === "quick-open") ui.setQuickOpenOpen(!ui.quickOpenOpen);
    });
    const offNavigate = onEvent("menu:navigate", ({ kind }) => {
      handleMenuNavigate(kind);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offAction();
      offNavigate();
    };
  }, []);
}
