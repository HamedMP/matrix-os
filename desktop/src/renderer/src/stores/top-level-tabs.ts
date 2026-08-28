import { useDesktopSurfaces } from "./desktop-surfaces";
import { useTabs, type Tab } from "./tabs";

/**
 * Opens a separate mounted app instance in the native Desktop's top-level tab
 * workspace and keeps the tab and surface stores on the same retained ID set.
 */
export function openTopLevelTabInstance(
  sourceTabId: string,
  spec: Omit<Tab, "id" | "closable"> & { closable?: boolean },
): string {
  const tabs = useTabs.getState();
  const newTabId = tabs.openTabInstance(spec);
  useDesktopSurfaces.getState().openSiblingTab(
    sourceTabId,
    newTabId,
    useTabs.getState().tabs.map((tab) => tab.id),
  );
  return newTabId;
}
