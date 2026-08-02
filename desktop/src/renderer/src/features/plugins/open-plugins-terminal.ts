// Opens a canonical terminal session for Plugins hub management tasks (MCP
// server config, skill files). Same flow as provider setup terminals
// (features/coding-agents/provider-setup-terminal.ts): create the session
// through the gateway, then focus it as a terminal tab. Session names are
// deterministic per topic, so a second click re-attaches to the same session
// (the gateway registry adopts existing sessions).
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import type { useTabs } from "../../stores/tabs";

const SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;

export const PLUGINS_TERMINAL_CWD = "projects";

export async function openPluginsTerminal(
  api: ApiClient,
  openTab: ReturnType<typeof useTabs.getState>["openTab"],
  options: { sessionName: string; title: string },
): Promise<"opened" | "failed" | "runtime-changed"> {
  // The request URL is resolved against the runtime selected right now.
  const { runtimeSlot, authGeneration } = useConnection.getState();
  try {
    const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", {
      name: options.sessionName,
      cwd: PLUGINS_TERMINAL_CWD,
    });
    // Switching computers mid-request clears the tab strip and repoints the
    // terminal transport. The session created above lives on the previous
    // computer, so opening a tab for it would attach to the wrong runtime.
    const current = useConnection.getState();
    if (current.runtimeSlot !== runtimeSlot || current.authGeneration !== authGeneration) {
      // The POST succeeded, so a real session now exists on the previous
      // computer. Reporting this as a failure would show "something went wrong
      // on the server" for an operation that worked.
      console.warn(
        "[plugins] abandoned a terminal session created on the previous computer:",
        options.sessionName,
      );
      return "runtime-changed";
    }
    const sessionName =
      typeof response.name === "string" && SESSION_NAME_PATTERN.test(response.name)
        ? response.name
        : options.sessionName;
    openTab({ kind: "terminal", sessionName, title: options.title });
    return "opened";
  } catch (err: unknown) {
    console.error(
      "[plugins] Failed to open terminal session:",
      err instanceof Error ? err.name : "Unknown error",
    );
    return "failed";
  }
}
