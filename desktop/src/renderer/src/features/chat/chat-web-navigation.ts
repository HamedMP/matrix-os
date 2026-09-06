import { useBrowserNavigation } from "../../stores/browser-navigation";
import { useTabs } from "../../stores/tabs";

export function openChatWebLink(address: string): boolean {
  if (!/^https?:\/\//i.test(address)) return false;
  if (useBrowserNavigation.getState().request(address) === null) return false;
  useTabs.getState().openTab({ kind: "browser", title: "Browser" });
  return true;
}
