import { useEffect } from "react";
import { onEvent } from "../../lib/operator";
import { useBoard } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function handleMenuNavigate(kind: string): void {
  if (kind === "settings") {
    useTabs.getState().openTab({ kind: "settings", title: "Settings" });
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

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        ui.setComposerOpen(!ui.composerOpen);
        return;
      }
      if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        ui.setQuickOpenOpen(!ui.quickOpenOpen);
        return;
      }
      if (!meta && e.key.toLowerCase() === "c" && !isTypingTarget(e.target)) {
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
      handleMenuNavigate(kind);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offAction();
      offNavigate();
    };
  }, []);
}
