import { useEffect } from "react";
import { onEvent } from "../../lib/operator";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
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
        e.preventDefault();
        ui.setComposerOpen(!ui.composerOpen);
        return;
      }
      if (meta && key === "p") {
        e.preventDefault();
        ui.setQuickOpenOpen(!ui.quickOpenOpen);
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
        if (tabs.activeTabId) {
          const tab = tabs.tabs.find((t) => t.id === tabs.activeTabId);
          if (tab?.closable) {
            e.preventDefault();
            tabs.closeTab(tabs.activeTabId);
          }
        }
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
        e.preventDefault();
        const idx = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
        const delta = e.shiftKey ? -1 : 1;
        const next = tabs.tabs[(idx + delta + tabs.tabs.length) % tabs.tabs.length];
        if (next) tabs.focusTab(next.id);
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
      if (action === "new-thread") ui.setComposerOpen(true);
      if (action === "palette") ui.setPaletteOpen(!ui.paletteOpen);
      if (action === "quick-open") ui.setQuickOpenOpen(!ui.quickOpenOpen);
    });
    const offNavigate = onEvent("menu:navigate", ({ kind }) => {
      if (kind === "settings") useTabs.getState().openTab({ kind: "settings", title: "Settings" });
      else useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offAction();
      offNavigate();
    };
  }, []);
}
