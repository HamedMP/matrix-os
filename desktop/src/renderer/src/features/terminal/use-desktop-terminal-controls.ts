import { AppError } from "../../../../shared/app-error";
import { useCallback, useMemo, type RefObject } from "react";
import {
  dispatchTerminalPaneRequest,
  useTerminalControls,
  type TerminalControlsTransport,
} from "@matrix-os/ui";
import type { TerminalPaneAction } from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import type { ShellSocketState } from "../../lib/shell-socket";
import type { ActiveAttachment } from "./attach-manager";

interface DesktopTerminalControlsOptions {
  api: ApiClient | null;
  sessionName: string;
  chatId?: string;
  active: boolean;
  socketState: ShellSocketState;
  writable: boolean;
  isMac: boolean;
  attachmentRef: RefObject<ActiveAttachment | null>;
  termRef: RefObject<{ focus(): void } | null>;
  /**
   * Pane actions handled by the host instead of the computer's Zellij panes
   * (the Terminal window's own split tree, spec 2706). Scrolling still goes
   * to the computer when there is one.
   */
  onPaneAction?: (action: TerminalPaneAction) => void;
}

/** Keep the renderer's authenticated transport outside shared terminal behavior. */
export function useDesktopTerminalControls({
  api,
  sessionName,
  chatId,
  active,
  socketState,
  writable,
  isMac,
  attachmentRef,
  termRef,
  onPaneAction,
}: DesktopTerminalControlsOptions) {
  const transport = useMemo<TerminalControlsTransport | null>(
    () => {
      const computer: TerminalControlsTransport | null = api
        ? {
            getPreferences: () => api.get("/api/terminal/preferences"),
            savePreferences: (keyboard) =>
              api.put("/api/terminal/preferences", { keyboard }),
            paneAction: (sessionName, action) =>
              dispatchTerminalPaneRequest({
                post: (path, body) => api.post(path, body),
                isMissingRoute: (error) =>
                  error instanceof AppError &&
                  error.category === "notFound" &&
                  error.detail === undefined,
                sessionName,
                chatId,
                action,
              }),
          }
        : null;
      if (!onPaneAction) return computer;
      return {
        getPreferences: computer?.getPreferences ?? (async () => ({ preferences: { keyboard: { profile: "mac", overrides: {} } } })),
        savePreferences: computer?.savePreferences ?? (async () => { throw new AppError("server"); }),
        paneAction: async (session, action) => {
          if (action.type === "scroll" && computer) return computer.paneAction(session, action);
          onPaneAction(action);
          return undefined;
        },
      };
    },
    [api, chatId, onPaneAction],
  );
  const enabled = active && writable && socketState === "attached" && (api !== null || onPaneAction !== undefined);
  const sendInput = useCallback(
    (data: string) => {
      const attachment = attachmentRef.current;
      if (enabled && attachment?.sessionName === sessionName)
        attachment.write(data);
    },
    [attachmentRef, enabled, sessionName],
  );
  const focus = useCallback(() => {
    if (active) termRef.current?.focus();
  }, [active, termRef]);
  return useTerminalControls({
    sessionName,
    enabled,
    isMac,
    transport,
    sendInput,
    focus,
  });
}
