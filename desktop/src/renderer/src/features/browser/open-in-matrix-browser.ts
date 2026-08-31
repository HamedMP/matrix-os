import { useBrowserNavigation } from "../../stores/browser-navigation";
import { useTabs } from "../../stores/tabs";

/** Queue a validated address for its source runtime and focus the built-in Matrix Browser tab. */
export function openInMatrixBrowser(address: string, runtimeScope?: string): boolean {
  const requestId = useBrowserNavigation.getState().request(address, runtimeScope);
  if (requestId === null) return false;
  useTabs.getState().openTab({ kind: "browser", title: "Browser" });
  return true;
}
