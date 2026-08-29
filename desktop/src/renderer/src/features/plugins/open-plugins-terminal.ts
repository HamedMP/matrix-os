// Opens the shared Terminal app for Plugins hub management tasks (MCP server
// config, skill files). Plugins must not create a hidden or topic-specific
// terminal session; the Terminal app owns session creation and attachment.
import type { useTabs } from "../../stores/tabs";

export async function openPluginsTerminal(
  openTab: ReturnType<typeof useTabs.getState>["openTab"],
): Promise<"opened"> {
  openTab({ kind: "terminals", title: "Terminal" });
  return "opened";
}
