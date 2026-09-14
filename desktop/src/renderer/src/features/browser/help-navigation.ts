import type { Tab } from "../../stores/tabs";
import { useBrowserNavigation } from "../../stores/browser-navigation";

export const MATRIX_HELP_URL = "https://matrix-os.com/docs";

type OpenTab = (spec: Omit<Tab, "id" | "closable"> & { closable?: boolean }) => string;

export function openHelpInMatrixBrowser(openTab: OpenTab): void {
  useBrowserNavigation.getState().request(MATRIX_HELP_URL);
  openTab({ kind: "browser", title: "Browser" });
}
