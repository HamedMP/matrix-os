// Opens a canonical terminal session for Plugins hub management tasks (MCP
// server config, skill files). Same flow as provider setup terminals
// (features/coding-agents/provider-setup-terminal.ts): create the session
// through the gateway, then focus it as a terminal tab. Session names are
// deterministic per topic, so a second click re-attaches to the same session
// (the gateway registry adopts existing sessions).
import type { ApiClient } from "../../lib/api";
import type { useTabs } from "../../stores/tabs";

const SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;

export const PLUGINS_TERMINAL_CWD = "projects";

export async function openPluginsTerminal(
  api: ApiClient,
  openTab: ReturnType<typeof useTabs.getState>["openTab"],
  options: { sessionName: string; title: string },
): Promise<boolean> {
  try {
    const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", {
      name: options.sessionName,
      cwd: PLUGINS_TERMINAL_CWD,
    });
    const sessionName =
      typeof response.name === "string" && SESSION_NAME_PATTERN.test(response.name)
        ? response.name
        : options.sessionName;
    openTab({ kind: "terminal", sessionName, title: options.title });
    return true;
  } catch (err: unknown) {
    console.error(
      "[plugins] Failed to open terminal session:",
      err instanceof Error ? err.name : typeof err,
    );
    return false;
  }
}
