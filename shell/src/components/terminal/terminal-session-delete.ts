/** Keep the existing session visible while its backend process is shutting down. */
export async function deleteTerminalSession(options: {
  gateway: string;
  workspaceId: string;
  tabId: string;
  confirmed: () => void;
  error: (message: string) => void;
}): Promise<boolean> {
  try {
    const response = await fetch(`${options.gateway}/api/terminal/workspaces/${options.workspaceId}/tabs/${options.tabId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      options.error("Failed to remove shell");
      return false;
    }
    options.confirmed();
    return true;
  } catch (error: unknown) {
    console.warn("Failed to remove shell session:", error instanceof Error ? error.name : "unknown_error");
    options.error("Could not remove shell");
    return false;
  }
}
