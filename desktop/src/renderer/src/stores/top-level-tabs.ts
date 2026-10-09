import { useDesktopSurfaces, type DesktopSiblingPresentation } from "./desktop-surfaces";
import { useTabs, type Tab } from "./tabs";

/**
 * Opens a separate mounted app instance and keeps tab/surface retained IDs in
 * sync. Top-level tab creation explicitly promotes to tabs by default; New
 * Context can inherit the source presentation without changing its window.
 */
export function openTopLevelTabInstance(
  sourceTabId: string,
  spec: Omit<Tab, "id" | "closable"> & { closable?: boolean },
  presentation: DesktopSiblingPresentation = "tab",
): string {
  const tabs = useTabs.getState();
  const newTabId = tabs.openTabInstance(spec);
  useDesktopSurfaces.getState().openSiblingTab(
    sourceTabId,
    newTabId,
    useTabs.getState().tabs.map((tab) => tab.id),
    presentation,
  );
  return newTabId;
}
