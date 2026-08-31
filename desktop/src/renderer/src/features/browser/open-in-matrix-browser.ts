import { useBrowserNavigation } from "../../stores/browser-navigation";
import { useTabs } from "../../stores/tabs";

/** Queue a validated address and focus the built-in Matrix Browser tab. */
export function openInMatrixBrowser(address: string): boolean {
  const requestId = useBrowserNavigation.getState().request(address);
  if (requestId === null) return false;
  useTabs.getState().openTab({ kind: "browser", title: "Browser" });
  return true;
}
