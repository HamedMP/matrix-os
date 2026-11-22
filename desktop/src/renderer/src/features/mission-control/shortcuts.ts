import { useEffect } from "react";
import type { ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import { requestChatSearchShortcut } from "@matrix-os/ui";
import { invoke, onEvent } from "../../lib/operator";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import { defaultProjectId, openProjectChat } from "../../lib/project-chat";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { openTopLevelTabInstance } from "../../stores/top-level-tabs";
import {
  isDesktopSurfaceVisible,
  topmostVisibleDesktopSurfaceId,
  useDesktopSurfaces,
} from "../../stores/desktop-surfaces";
import { HOSTED_SHELL_TAB_SPEC } from "../../lib/hosted-shell";
import {
  closeApp,
  cycleApp,
  focusApp,
  minimizeActiveApp,
  openAndFocusApp,
  openFilesApp,
  reopenClosedApp,
  switchToApp,
  toggleActiveAppFullSize,
  toggleAppLauncher,
  toggleShowDesktop,
} from "../desktop-shell/app-switching";

interface NewAgentRunShortcutUiState {
  composerOpen: boolean;
  setComposerOpen(open: boolean): void;
}

interface NewAgentRunShortcutWorkspaceState {
  summary: { capabilities: Array<{ id: string; enabled: boolean }> } | null;
  requestComposerFocus(): void;
}

type OpenTabSpec = Parameters<ReturnType<typeof useTabs.getState>["openTab"]>[0];

/** Opens or reuses the app's tab and shows it, even if its window was closed or minimized. */
function showApp(spec: OpenTabSpec): void {
  openAndFocusApp(() => useTabs.getState().openTab(spec));
}

export function handleMenuNavigate(kind: string): void {
  if (kind === "settings") {
    showApp({ kind: "settings", title: "Settings" });
    return;
  }
  if (kind === "terminals") {
    handleTerminalFocusShortcut({ preventDefault: () => undefined });
    return;
  }
  if (kind === "board" || kind === "project") {
    const { activeProjectSlug, projects } = useBoard.getState();
    const project = projects.find((candidate) => candidate.slug === activeProjectSlug) ?? projects[0];
    showApp(project
      ? { kind: "project", projectSlug: project.slug, title: project.name || project.slug }
      : HOSTED_SHELL_TAB_SPEC);
    return;
  }
  if (kind !== "home") {
    console.warn(`[shortcuts] unsupported menu:navigate kind: ${kind}`);
  }
  showApp(HOSTED_SHELL_TAB_SPEC);
}

export function handleCloseSelectedAppShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
): void {
  event.preventDefault();
  const activeTab = activeShortcutTab();
  if (!activeTab) return;
  const fallbackId = topmostVisibleDesktopSurfaceId(
    useTabs.getState().tabs.map((tab) => tab.id),
    useDesktopSurfaces.getState(),
    activeTab.id,
  );
  // closeApp focuses the visible fallback app, as a click on the close button does.
  closeApp(activeTab);
  if (fallbackId) return;
  // Nothing visible remains: select nothing rather than an app the user cannot see.
  const selectedTabId = useTabs.getState().activeTabId;
  if (selectedTabId) useTabs.getState().clearActiveTab(selectedTabId);
}

function activeShortcutTab() {
  const tabs = useTabs.getState();
  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  if (!activeTab) return activeTab;
  const surfaces = useDesktopSurfaces.getState();
  return isDesktopSurfaceVisible(activeTab.id, surfaces)
    ? activeTab
    : undefined;
}

function topLevelTabSpec(activeTab: Tab) {
  if (activeTab.kind === "files") {
    return {
      kind: "files" as const,
      title: activeTab.title,
      slug: activeTab.slug,
      closable: true,
    };
  }
  if (activeTab.kind === "terminals" || activeTab.kind === "terminal") {
    return {
      kind: "terminals" as const,
      title: "Terminal",
      closable: true,
    };
  }
  if (activeTab.kind === "chat" || (activeTab.kind === "work" && activeTab.workRoute === "chat")) {
    return {
      kind: "chat" as const,
      title: "Chat",
      chatView: "draft" as const,
      closable: true,
    };
  }
  return null;
}

export function handleNewTopLevelTabShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
): boolean {
  event.preventDefault();
  const activeTab = activeShortcutTab();
  if (!activeTab) return false;
  const spec = topLevelTabSpec(activeTab);
  if (!spec) return false;
  openTopLevelTabInstance(activeTab.id, spec);
  return true;
}

export function handleCloseTopLevelTabShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
): void {
  handleCloseSelectedAppShortcut(event);
}

export function handleNewContextShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
): void {
  event.preventDefault();
  const activeTab = activeShortcutTab();
  if (!activeTab) return;
  if (activeTab.kind !== "chat" && !(activeTab.kind === "work" && activeTab.workRoute === "chat")) {
    return;
  }
  openTopLevelTabInstance(activeTab.id, {
    kind: "chat",
    title: "Chat",
    chatView: "draft",
    closable: true,
  }, "source");
}

export function handleTerminalFocusShortcut(event: Pick<KeyboardEvent, "preventDefault">): void {
  event.preventDefault();
  const existing = useTabs.getState().tabs.find((tab) => tab.kind === "terminal" || tab.kind === "terminals");
  if (existing) {
    focusApp(existing.id);
    return;
  }
  showApp({ kind: "terminals", title: "Terminal" });
}

function canRequestAgentComposerFocus(summary: NewAgentRunShortcutWorkspaceState["summary"]): boolean {
  if (!summary) return true;
  return summary.capabilities.some((capability) => capability.id === "codingAgentsThreadCreate" && capability.enabled);
}

export function handleNewAgentRunShortcut(
  event: Pick<KeyboardEvent, "preventDefault">,
  ui: NewAgentRunShortcutUiState,
  workspace: NewAgentRunShortcutWorkspaceState,
  options: { desktopWorkspaceEnabled?: boolean } = {},
): void {
  event.preventDefault();
  const desktopWorkspaceEnabled = options.desktopWorkspaceEnabled ?? CODING_AGENTS_DESKTOP_WORKSPACE;
  // A global "new chat" lands in the current project (open project tab first,
  // then the board's active project); without any project the legacy kernel
  // composer modal is the only place a run can go.
  const projectId = desktopWorkspaceEnabled ? defaultProjectId() : null;
  if (!projectId) {
    ui.setComposerOpen(true);
    return;
  }
  // Opening the composer itself is gated on thread creation support; the
  // project's Chats view still opens either way.
  const canCompose = canRequestAgentComposerFocus(workspace.summary);
  if (canCompose) workspace.requestComposerFocus();
  openAndFocusApp(() => {
    // openProjectChat selects the project's tab before its first await.
    void openProjectChat(projectId, { compose: canCompose });
    return useTabs.getState().activeTabId ?? "";
  });
}

function openChatSearchOrPalette(): void {
  const ui = useUi.getState();
  if (!ui.paletteOpen && requestChatSearchShortcut()) return;
  ui.setPaletteOpen(!ui.paletteOpen);
}

const noEvent = { preventDefault: () => undefined };

function switchTo(position: number): () => void {
  return () => switchToApp(position);
}

// Main matches the keys and the app menu; the renderer only runs the action.
const SHORTCUT_HANDLERS: Record<ShortcutActionId, () => void> = {
  "app.next": () => cycleApp(1),
  "app.previous": () => cycleApp(-1),
  "app.launcher": toggleAppLauncher,
  "app.close": () => handleCloseSelectedAppShortcut(noEvent),
  "app.minimize": minimizeActiveApp,
  "app.reopen": reopenClosedApp,
  "app.switch-1": switchTo(1),
  "app.switch-2": switchTo(2),
  "app.switch-3": switchTo(3),
  "app.switch-4": switchTo(4),
  "app.switch-5": switchTo(5),
  "app.switch-6": switchTo(6),
  "app.switch-7": switchTo(7),
  "app.switch-8": switchTo(8),
  "app.switch-9": switchTo(9),
  "app.show-desktop": toggleShowDesktop,
  "app.toggle-full-size": toggleActiveAppFullSize,
  "app.open-files": openFilesApp,
  "nav.palette": openChatSearchOrPalette,
  "nav.quick-open": () => {
    const ui = useUi.getState();
    ui.setQuickOpenOpen(!ui.quickOpenOpen);
  },
  "nav.settings": () => handleMenuNavigate("settings"),
  "tabs.new-context": () => handleNewContextShortcut(noEvent),
  "tabs.new": () => { handleNewTopLevelTabShortcut(noEvent); },
  "tabs.close": () => handleCloseTopLevelTabShortcut(noEvent),
  "chat.new-thread": () => handleNewAgentRunShortcut(noEvent, useUi.getState(), useCodingAgentWorkspace.getState()),
  "chat.open": () => showApp({ kind: "chat", title: "Chat", closable: false }),
  "terminal.focus": () => handleTerminalFocusShortcut(noEvent),
  "terminal.window": () => {
    void invoke("terminal-window:open", {}).catch((error: unknown) => {
      console.warn("[shortcuts] could not open the Terminal window:", error);
    });
  },
};

export function runShortcutAction(id: ShortcutActionId): void {
  SHORTCUT_HANDLERS[id]();
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    return onEvent("shortcut:action", ({ id }) => runShortcutAction(id));
  }, []);
}
