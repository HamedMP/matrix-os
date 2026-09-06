import type { TerminalControlsTransport } from "@matrix-os/ui";

/** Uses the same owner-authenticated, VM-scoped gateway as terminal sessions. */
export function createWebTerminalControlsTransport(gatewayUrl: string): TerminalControlsTransport {
  const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    try {
      const response = await fetch(`${gatewayUrl}/api/terminal${path}`, {
        method,
        credentials: "same-origin",
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined ? {} : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      if (!response.ok) throw new Error("Terminal request failed");
      return await response.json();
    } catch (error: unknown) {
      console.warn("Terminal control request failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("Terminal request failed");
    }
  };
  return {
    getPreferences: () => request("/preferences"),
    savePreferences: (keyboard) => request("/preferences", "PUT", { keyboard }),
    paneAction: (sessionName, action) => request(`/sessions/${encodeURIComponent(sessionName)}/pane-actions`, "POST", action),
  };
}
