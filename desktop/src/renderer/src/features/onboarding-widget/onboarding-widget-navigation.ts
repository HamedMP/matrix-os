import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";

type TabSpec = Parameters<ReturnType<typeof useTabs.getState>["openTab"]>[0];

/** Selecting a retained tab does not restore its minimized or closed desktop window. */
export function showOnboardingTab(spec: TabSpec): string {
  const tabId = useTabs.getState().openTab(spec);
  useDesktopSurfaces.getState().activateSurface(tabId);
  return tabId;
}
