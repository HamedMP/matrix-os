import {
  dispatchTerminalPaneRequest,
  type TerminalControlsTransport,
} from "@matrix-os/ui";

class TerminalRequestError extends Error {
  constructor(readonly missingRoute = false) {
    super("Terminal request failed");
  }
}

/** Uses the same owner-authenticated, VM-scoped gateway as terminal sessions. */
export function createWebTerminalControlsTransport(
  gatewayUrl: string,
): TerminalControlsTransport {
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> => {
    try {
      const response = await fetch(`${gatewayUrl}${path}`, {
        method,
        credentials: "same-origin",
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      if (!response.ok) {
        // Only a plain router 404 permits a compatibility retry. Structured
        // errors (including session_not_found) must retain their semantics.
        const text = response.status === 404 ? await response.text() : "";
        throw new TerminalRequestError(
          response.status === 404 && text.trim() === "404 Not Found",
        );
      }
      return await response.json();
    } catch (error: unknown) {
      console.warn(
        "Terminal control request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error instanceof TerminalRequestError
        ? error
        : new TerminalRequestError();
    }
  };
  return {
    getPreferences: () => request("/api/terminal/preferences"),
    savePreferences: (keyboard) =>
      request("/api/terminal/preferences", "PUT", { keyboard }),
    paneAction: (sessionName, action) =>
      dispatchTerminalPaneRequest({
        post: (path, body) => request(path, "POST", body),
        isMissingRoute: (error) =>
          error instanceof TerminalRequestError && error.missingRoute,
        sessionName,
        action,
      }),
  };
}
