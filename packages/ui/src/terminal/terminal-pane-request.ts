import type { TerminalPaneAction } from "@matrix-os/contracts";

export class TerminalPaneActionsUnavailableError extends Error {
  constructor() {
    super(
      "Update this computer to use these pane controls. Standalone terminal splits are available on older versions.",
    );
    this.name = "TerminalPaneActionsUnavailableError";
  }
}

/** Older host bundles support standalone splits at /panes. Never bypass a
 * recognized session/auth error or drop Chat's authorization context to retry. */
export async function dispatchTerminalPaneRequest({
  post,
  isMissingRoute,
  sessionName,
  chatId,
  action,
}: {
  post(path: string, body: unknown): Promise<unknown>;
  isMissingRoute(error: unknown): boolean;
  sessionName: string;
  chatId?: string;
  action: TerminalPaneAction;
}): Promise<unknown> {
  const session = `/api/terminal/sessions/${encodeURIComponent(sessionName)}`;
  try {
    return await post(
      `${session}/pane-actions${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`,
      action,
    );
  } catch (error: unknown) {
    if (!isMissingRoute(error)) throw error;
    if (action.type === "split" && !chatId)
      return post(`${session}/panes`, { direction: action.direction });
    throw new TerminalPaneActionsUnavailableError();
  }
}
